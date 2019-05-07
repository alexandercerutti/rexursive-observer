import { Subject, Subscription, Observable } from "rxjs";
import { observedObjects } from "./observedObjectsSymbol";
import * as debug from "debug";

const roxeDebug = debug("roxe");

export type ObservableObject<T> = _ObservableObject<T> & T;
interface ObservableConstructor {
	new<T>(from: T, optHandlers?: ProxyHandler<any>): ObservableObject<T>;
}

interface Observed {
	[key: string]: Subject<any>
}

interface AnyKindOfObject {
	[key: string]: any;
}

class _ObservableObject<T> {
	private [observedObjects]: Observed = {};

	constructor(from: T = <T>{}, optHandlers: ProxyHandler<any> = {}) {
		let setCustomHandler: ((obj: any, prop: string, value: any, receiver?: any) => boolean) | undefined;
		let getCustomHandler: ((obj: any, prop: string | number | symbol, receiver?: any) => any) | undefined;

		if (optHandlers && Object.keys(optHandlers).length) {
			if (optHandlers.set) {
				setCustomHandler = optHandlers.set;
				delete optHandlers.set;
			}

			if (optHandlers.get) {
				getCustomHandler = optHandlers.get;
			}
		}

		const handlers = Object.assign(optHandlers, {
			// Note for future: leave receiver as parameter even if not used
			// to keep args as the last and not include receiver in this one
			set: (obj: any, prop: string, value: any, receiver?: any, ...args: any[]): boolean => {
				let notificationChain: AnyKindOfObject;
				if (typeof value === "object") {
					// Creating the chain of properties that will be notified
					notificationChain = Object.assign({
						[prop]: value,
					}, buildNotificationChain(value, prop));


					if (setCustomHandler) {
						let setResult = setCustomHandler(obj, prop, value, receiver);

						if (setResult === false) {
							return setResult;
						}
					}
					/*
					 * We when we set a property which will be an object
					 * we set it as a Proxy and pass it
					 * an edited SETTER with binded trailing keys to reach
					 * this property.
					 * E.g. if we have an object structure like x.y.z.w
					 * x, x.y and x.y.z will be Proxies; each property
					 * will receive a setter with the parent keys.
					 * w property, will receive below (in else),
					 * ["x", "y", "z"] as args.
					 *
					 * We have to copy handlers to a new object to keep
					 * the original `handlers.set` clean from any external argument
					 */
					obj[prop] = new Proxy(value, Object.assign({}, handlers, {
						set: bindLast(handlers.set, ...args, prop),
					}));
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

					if (setCustomHandler) {
						let setResult = setCustomHandler(obj, prop, value, receiver);

						if (setResult === false) {
							return setResult;
						}
					}

					obj[prop] = value;

					const elementKey = args.length ? [...args, prop].join(".") : prop;
					notificationChain = {
						[elementKey] : value
					};
				}

				Object.keys(notificationChain).forEach((keyPath) => {
					const value = notificationChain[keyPath];
					// We want both single properties an complex objects to be notified when edited
					if (this[observedObjects][keyPath]) {
						this[observedObjects][keyPath].next(value);
					}
				});

				return true;
			},
			get: bindLast((target: any, prop: string | number | symbol, receiver: any, customGetter?: typeof getCustomHandler) => {
				if (customGetter !== undefined && !(prop in _ObservableObject.prototype)) {
					return customGetter(target, prop, receiver);
				}

				return Reflect.get(target, prop, receiver);
			}, getCustomHandler)
		});

		return new Proxy(Object.assign(this, buildInitialProxyChain(from, handlers)), handlers);
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
		let snapshot: any;
		let firstUnavailableKey: string = "";

		if (path && typeof path === "string") {
			snapshot = path.split(".").reduce((acc: AnyKindOfObject, current: string) => {
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
		} else {
			snapshot = Object.assign({} as T, this);
			// In the snapshot, we don't need the symbol that collects
			// All the observers
			delete snapshot[observedObjects];
		}

		return snapshot;
	}
}

// Workaround to allow us to recognize T's props as part of ObservableObject
// https://stackoverflow.com/a/54737176/2929433
export const ObservableObject: ObservableConstructor = _ObservableObject as any;

/**
 * Builds the initial object-proxy composed of proxies objects
 * @param sourceObject
 * @param handlers
 */

function buildInitialProxyChain(sourceObject: AnyKindOfObject, handlers: ProxyHandler<any>, ...args: any[]): ProxyConstructor {
	let chain: AnyKindOfObject = {};
	for (const prop in sourceObject) {
		if (typeof sourceObject[prop] === "object" && !Array.isArray(sourceObject[prop])) {
			chain[prop] = buildInitialProxyChain(sourceObject[prop], Object.assign({}, handlers, {
				set: bindLast(handlers.set!, ...args, prop)
			}), ...args, prop);
		} else {
			chain[prop] = sourceObject[prop];
		}
	}

	return new Proxy(chain, handlers);
}

/**
 * Builds the chain of properties that will be notified.
 * This is used when a property that is or will be
 * an object, is assigned.
 * The function will compose an object { "x.y.z": value }
 * for each key of each nested object.
 * @param source - Current object
 * @param args
 */

function buildNotificationChain(source: AnyKindOfObject, ...args: string[]): AnyKindOfObject {
	let chain: AnyKindOfObject = {};
	for (const prop in source) {
		chain[[...args, prop].join(".")] = source[prop];

		if (typeof source[prop] === "object" && !Array.isArray(source[prop])) {
			Object.assign(chain, buildNotificationChain(source[prop], ...args, prop))
		}
	}

	return chain;
}

/**
 * Creates a function that accepts default arguments
 * with some other trailing arbitrary dev-defined arguments
 *
 * E.g. Setter receives the following arguments: obj, prop, value, receiver.
 * We wrap the original function in another one that adds the arguments;
 *
 * @param {Function} fn - the original function
 * @param {any[]} boundArgs - the arbitrary arguments
 */

function bindLast(fn: Function, ...boundArgs: any[]) {
	return (...args: [Object, string, any, any?]) => fn(...args, ...boundArgs);
}
