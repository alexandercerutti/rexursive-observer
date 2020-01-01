import { Subject, Subscription, Observable } from "rxjs";
import * as debug from "debug";
import { createProxyChain } from "./createProxyChain";
import { buildNotificationChain } from "./buildNotificationChain";
import { composeParentsChains } from "./composeParentsChain";

const roxeDebug = debug("roxe");
const customTraps = Symbol("_customTraps");
const observedObjects = Symbol("_observedObjects");
const weakParents = Symbol("wkp");

export type WKP = WeakMap<AnyKindOfObject, Set<string>>;

export type ObservableObject<T> = _ObservableObject<T> & T;
interface ObservableConstructor {
	new <T>(from: T, optHandlers?: ProxyHandler<any>): ObservableObject<T>;
}

interface Observed {
	[key: string]: Subject<any>
}

export interface AnyKindOfObject {
	[key: string]: any;
}

class _ObservableObject<T> {
	private [observedObjects]: Observed;
	private [customTraps]: ProxyHandler<Object>;
	private [weakParents]: WKP;

	constructor(from: T = <T>{}, optHandlers: ProxyHandler<any> = {}) {
		Object.defineProperties(this, {
			[observedObjects]: {
				value: {},
				writable: false,
				configurable: false,
				enumerable: false
			},
			[customTraps]: {
				value: {},
				writable: false,
				configurable: false,
				enumerable: false,
			},
			[weakParents]: {
				value: new WeakMap() as WKP,
				writable: false,
				configurable: false,
				enumerable: false
			}
		});

		if (optHandlers.set) {
			this[customTraps].set = optHandlers.set;
			delete optHandlers.set;
		}

		if (optHandlers.deleteProperty) {
			this[customTraps].deleteProperty = optHandlers.deleteProperty;
			delete optHandlers.deleteProperty;
		}

		const handlers = Object.assign(optHandlers, {
			set: (obj: AnyKindOfObject, prop: string | number, value: any, receiver?: any): boolean => {
				const rawChains = Array.from(this[weakParents].get(receiver) || []);
				const objectChains = composeParentsChains(prop, rawChains);
				const notificationChain = buildNotificationChain(obj[prop], value, ...objectChains);

				if (typeof value === "object") {
					if (this[customTraps].set && this[customTraps].set!(obj, prop, value, receiver) === false) {
						return false;
					}

					/**
					 * When a property is set with an Object, we
					 * create for it a Proxy-chain (itself included).
					 * Each object will have a record in the root object
					 * weakMap, so we can easily access to the chains
					 * to reach that object (and to create notifications).
					 * Each chain is composed like "a.b.c".
					 */

					obj[prop] = createProxyChain(value, handlers, { all: this[weakParents] }, objectChains);
				} else {
					/*
					 * We finalize the path of the keys passed in the above condition
					 * to reach “object endpoint” (like "w" for the prev. example)
					 * The path keys composition, let us subscribe to observables
					 * with dot notation like x.y.z.w
					 */

					if (obj[prop] === value) {
						/*
						 * If the value is the same, we return true.
						 * This cannot be considered as a fail. Also, failing would bring
						 * a strict-mode script to throw a TypeError.
						 */
						return true;
					}

					if (this[customTraps].set && this[customTraps].set!(obj, prop, value, receiver) === false) {
						return false;
					}

					obj[prop] = value;
				}

				this.__fireNotifications(notificationChain || {});
				return true;
			},
			deleteProperty: (target: any, prop: string | number | symbol): boolean => {
				const propsChain = [...(target[Symbol.for("__parent")] || []), prop];
				const notificationChain = buildNotificationChain(target[prop], undefined, ...propsChain);

				/**
				 * First we delete the property,
				 * then we fire the notifications
				 * (only if deletion went successfully).
				 * If there's a custom deleteProperty, it
				 * will handle deletion and its result
				 * will determine if notifications should
				 * be fired or not.
				 */

				let deleted: boolean;

				if (this[customTraps].deleteProperty) {
					deleted = this[customTraps].deleteProperty!(target, prop);
				} else {
					deleted = Reflect.deleteProperty(target, prop);
				}

				if (deleted) {
					this.__fireNotifications(notificationChain);
				}

				return deleted;
			}
		});

		return new Proxy(Object.assign(this, createProxyChain(from, handlers, { all: this[weakParents] })), handlers);
	}

	/**
	 * Registers a custom property to be observed.
	 *
	 * @param {string} prop - The property or object
	 * 		property to subscribe to (e.g. `epsilon`
	 * 		or `time.current`)
	 */

	observe<A = any>(prop: string): Observable<A> {
		if (!this[observedObjects][prop]) {
			this[observedObjects][prop] = new Subject<A>();
		}

		return this[observedObjects][prop].asObservable();
	}

	/**
	 * Unsubscribes from all the subscriptions in a specific pool
	 * @param subscriptions
	 */

	unsubscribeAll(subscriptions: Subscription[]): void {
		subscriptions.forEach(sub => sub.unsubscribe());
	}

	/**
	 * Returns the current image of a key of the main
	 * object or a nested key.
	 *
	 * @param {string} path - dotted-notation path ("a.b.c")
	 * @returns {any | undefined} - the whole observed object or part of it.
	 * 	Undefined if the path is not matched;
	 */

	snapshot(path?: string): any {
		let firstUnavailableKey: string = "";

		if (!(path && typeof path === "string")) {
			const snapshot = Object.assign({} as T, this);
			// In the snapshot, we don't need the symbol that collects
			// All the observers
			delete snapshot[observedObjects];
			delete snapshot[customTraps];
			return snapshot;
		}

		const snapshot = path.split(".").reduce((acc: AnyKindOfObject, current: string) => {
			if (!(acc && typeof acc === "object" && !Array.isArray(acc) && current && (acc as Object).hasOwnProperty(current))) {
				// if the previous iteration returns undefined,
				// we'll forward this until the end of the loop.
				// We keep the first unavailable key for debug.
				firstUnavailableKey = firstUnavailableKey || current;
				return undefined;
			}

			return acc[current];
		}, this);

		if (snapshot === undefined) {
			roxeDebug(`Cannot access to path "${path}". "${firstUnavailableKey}" is not reachable`);
			return snapshot;
		}

		if (typeof snapshot === "object") {
			return Object.assign({}, snapshot);
		}

		return snapshot;
	}

	/**
	 * Calls next on RxJS Subject
	 * with the current value
	 * for each element in the chain
	 * @param notificationChain
	 * @private
	 */

	private __fireNotifications(notificationChain: AnyKindOfObject): void {
		const keys = Object.keys(notificationChain);
		for (let i = keys.length; i > 0;) {
			const key = keys[--i];
			const value = notificationChain[key];

			if (this[observedObjects][key]) {
				this[observedObjects][key].next(value);
			}
		}
	}
}

// Workaround to allow us to recognize T's props as part of ObservableObject
// https://stackoverflow.com/a/54737176/2929433
export const ObservableObject: ObservableConstructor = _ObservableObject as any;
