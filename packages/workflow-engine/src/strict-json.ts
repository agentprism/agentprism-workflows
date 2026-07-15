const HOST_OBJECT_CONSTRUCTOR_SOURCE = Function.prototype.toString.call(Object);

export type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | StrictJsonValue[]
  | { [key: string]: StrictJsonValue };

export type StrictJsonCapture =
  | { ok: true; clone: StrictJsonValue }
  | { ok: false; path: string };

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

/** Realm-neutral intrinsic Object.prototype recognition. */
function isRealmNeutralPlainRecord(value: object): boolean {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return false;
  }
  if (prototype === null) return true;
  try {
    if (Object.getPrototypeOf(prototype) !== null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
    if (!descriptor || !("value" in descriptor)) return false;
    const candidate = descriptor.value;
    return (
      typeof candidate === "function" &&
      candidate.prototype === prototype &&
      Function.prototype.toString.call(candidate) === HOST_OBJECT_CONSTRUCTOR_SOURCE
    );
  } catch {
    return false;
  }
}

function capture(value: unknown, path: string, ancestors: Set<object>): StrictJsonCapture {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return { ok: true, clone: value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { ok: true, clone: value } : { ok: false, path };
  }
  if (typeof value !== "object" || ancestors.has(value)) return { ok: false, path };

  ancestors.add(value);
  try {
    let symbols: symbol[];
    let names: string[];
    try {
      symbols = Object.getOwnPropertySymbols(value);
      names = Object.getOwnPropertyNames(value);
    } catch {
      return { ok: false, path };
    }
    if (symbols.length !== 0) return { ok: false, path: `${path}[symbol]` };

    if (Array.isArray(value)) {
      if (names.length !== value.length + 1 || !names.includes("length")) {
        return { ok: false, path };
      }
      const clone: StrictJsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const key = String(index);
        if (!names.includes(key)) return { ok: false, path: `${path}[${index}]` };
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, key);
        } catch {
          return { ok: false, path: `${path}[${index}]` };
        }
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          return { ok: false, path: `${path}[${index}]` };
        }
        const child = capture(descriptor.value, `${path}[${index}]`, ancestors);
        if (!child.ok) return child;
        clone.push(child.clone);
      }
      return { ok: true, clone };
    }

    if (!isRealmNeutralPlainRecord(value)) return { ok: false, path };
    const clone: { [key: string]: StrictJsonValue } = {};
    for (const key of names) {
      const childPath = propertyPath(path, key);
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        return { ok: false, path: childPath };
      }
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return { ok: false, path: childPath };
      }
      const child = capture(descriptor.value, childPath, ancestors);
      if (!child.ok) return child;
      Object.defineProperty(clone, key, {
        value: child.clone,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return { ok: true, clone };
  } finally {
    ancestors.delete(value);
  }
}

/** Validate and clone a value without coercion, reporting the first bad path. */
export function cloneStrictJsonValue(value: unknown): StrictJsonCapture {
  return capture(value, "$", new Set());
}

export function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(object, key);
    } catch {
      continue;
    }
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

export function cloneFrozenStrictJson(value: unknown): StrictJsonCapture {
  const result = cloneStrictJsonValue(value);
  if (result.ok) deepFreeze(result.clone);
  return result;
}

function sortCanonical(value: StrictJsonValue): StrictJsonValue {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value === null || typeof value !== "object") return value;
  const sorted: { [key: string]: StrictJsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(sorted, key, {
      value: sortCanonical(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return sorted;
}

/** Canonical strict JSON for hashing: object keys sorted recursively, arrays ordered. */
export function canonicalStrictJson(value: unknown): string | undefined {
  const result = cloneStrictJsonValue(value);
  return result.ok ? JSON.stringify(sortCanonical(result.clone)) : undefined;
}

export function cloneTelemetry<T>(value: T): T | undefined {
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return undefined;
  }
}
