//! B9 (issue #10): four ways to turn loader data living in V8 into a
//! `minijinja::Value`, so ADR D7 (render in Rust) can be judged on the
//! marshaling cost. See `docs/14-benchmarks.md` B9 and
//! `docs/08-template-engine.md`, "Where render time goes".
//!
//! 1. [`via_serde_json`]: `serde_v8` into `serde_json::Value`, then `Value::from(Serde(..))`.
//! 2. [`via_struct`]: `serde_v8` into `Vec<Product>`, then `Value::from(Serde(..))`.
//! 3. [`via_walker`]: a hand-written walker, V8 value straight to `minijinja::Value`.
//! 4. [`via_json_string`]: `JSON.stringify` in V8, `serde_json::from_str`, `Value::from(Serde(..))`.
//!
//! Extra, not in the issue: [`via_json_string_struct`], path 4 with path 2's
//! typed target (`JSON.stringify`, then `serde_json::from_str::<Vec<Product>>`).
//! It isolates the cost of V8 API calls, which dominate paths 1-3.

use std::sync::Once;

use minijinja::Value;
use minijinja::value::Serde;
use serde::{Deserialize, Serialize};

/// The B9 sample shape: the product fields of the `shop-products.html`
/// fixture (bench/spike/template-proto, issue #9), with `currency` moved into
/// one nested object as issue #10 asks: 10 fields of strings, integers,
/// floats, booleans, and one object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Product {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub price: f64,
    pub stock: u32,
    pub image: String,
    pub category: String,
    pub rating: f64,
    pub featured: bool,
    pub seller: Seller,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Seller {
    pub id: u32,
    pub name: String,
    pub currency: String,
}

/// JavaScript that defines `makeProducts(n)`, deterministic. Floats never have
/// an integral value, so V8 stores them as doubles in every path.
pub const PRODUCTS_JS: &str = r#"
function makeProducts(n) {
  const categories = ["Dates", "Spices", "Coffee", "Honey"];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: "p" + String(i).padStart(3, "0"),
      name: "Medjool dates " + (1 + i % 5) + " kg #" + i,
      slug: "product-" + i,
      price: 19.99 + i * 3.25,
      stock: (i * 7) % 13,
      image: "/img/products/" + i + ".webp",
      category: categories[i % 4],
      rating: 3.05 + (i % 20) / 10,
      featured: i % 10 === 0,
      seller: { id: 1 + i % 7, name: "Seller " + (i % 7), currency: "AED" },
    });
  }
  return out;
}
"#;

static INIT: Once = Once::new();

/// Initialises the V8 platform once per process.
pub fn init_v8() {
    INIT.call_once(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
}

/// An isolate and context with `makeProducts` defined.
pub struct Sandbox {
    // Field order matters: the context must drop before the isolate.
    context: v8::Global<v8::Context>,
    isolate: v8::OwnedIsolate,
}

impl Sandbox {
    pub fn new() -> Self {
        init_v8();
        let mut isolate = v8::Isolate::new(v8::CreateParams::default());
        let context = {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            let code = v8::String::new(scope, PRODUCTS_JS).expect("source string");
            let script = v8::Script::compile(scope, code, None).expect("compiles");
            script.run(scope).expect("runs");
            v8::Global::new(scope, context)
        };
        Self { context, isolate }
    }

    /// Creates `n` products in V8 (outside any measurement) and runs `f` with
    /// a scope and the resulting array, as a loader return value would be.
    pub fn with_products<R>(
        &mut self,
        n: usize,
        f: impl for<'s, 'i> FnOnce(&mut v8::PinScope<'s, 'i>, v8::Local<'s, v8::Value>) -> R,
    ) -> R {
        v8::scope!(let scope, &mut self.isolate);
        let context = v8::Local::new(scope, &self.context);
        let scope = &mut v8::ContextScope::new(scope, context);
        let code = v8::String::new(scope, &format!("makeProducts({n})")).expect("source");
        let script = v8::Script::compile(scope, code, None).expect("compiles");
        let products = script.run(scope).expect("runs");
        f(scope, products)
    }
}

impl Default for Sandbox {
    fn default() -> Self {
        Self::new()
    }
}

/// Path 1: `serde_v8` → `serde_json::Value` → `minijinja::Value` (`Value::from(Serde(..))`).
pub fn via_serde_json<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> Value {
    let json: serde_json::Value = serde_v8::from_v8(scope, value).expect("serde_v8");
    Value::from(Serde(&json))
}

/// Path 2: `serde_v8` → `Vec<Product>` → `minijinja::Value` (`Value::from(Serde(..))`).
pub fn via_struct<'s>(scope: &mut v8::PinScope<'s, '_>, value: v8::Local<'s, v8::Value>) -> Value {
    let products: Vec<Product> = serde_v8::from_v8(scope, value).expect("serde_v8");
    Value::from(Serde(&products))
}

/// Path 4 (naive baseline): `JSON.stringify` in V8 → `serde_json::from_str`
/// → `minijinja::Value` (`Value::from(Serde(..))`).
pub fn via_json_string<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> Value {
    let text = v8::json::stringify(scope, value)
        .expect("JSON.stringify")
        .to_rust_string_lossy(scope);
    let json: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
    Value::from(Serde(&json))
}

/// Extra path: `JSON.stringify` in V8 → `serde_json::from_str::<Vec<Product>>`
/// → `minijinja::Value`. One V8 call; the rest is plain Rust.
pub fn via_json_string_struct<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> Value {
    let text = v8::json::stringify(scope, value)
        .expect("JSON.stringify")
        .to_rust_string_lossy(scope);
    let products: Vec<Product> = serde_json::from_str(&text).expect("valid JSON");
    Value::from(Serde(&products))
}

/// Path 3: walk the V8 value and build the `minijinja::Value` directly, no
/// serde. Numbers follow `serde_v8`: uint32 and int32 become integers,
/// everything else a float. Functions, symbols and BigInts become `none`
/// (loader data is plain JSON-like data).
pub fn via_walker<'s>(scope: &mut v8::PinScope<'s, '_>, value: v8::Local<'s, v8::Value>) -> Value {
    if value.is_string() {
        return Value::from(value.to_rust_string_lossy(scope));
    }
    if value.is_uint32() {
        return Value::from(value.uint32_value(scope).unwrap_or_default());
    }
    if value.is_int32() {
        return Value::from(value.int32_value(scope).unwrap_or_default());
    }
    if value.is_number() {
        return Value::from(value.number_value(scope).unwrap_or(f64::NAN));
    }
    if value.is_boolean() {
        return Value::from(value.is_true());
    }
    if value.is_array() {
        let array = v8::Local::<v8::Array>::try_from(value).expect("is_array");
        let len = array.length();
        let mut items = Vec::with_capacity(len as usize);
        for i in 0..len {
            let item = array.get_index(scope, i).expect("array item");
            items.push(via_walker(scope, item));
        }
        return Value::from(items);
    }
    if value.is_object() && !value.is_function() {
        let object = value.to_object(scope).expect("is_object");
        let keys = object
            .get_own_property_names(scope, v8::GetPropertyNamesArgs::default())
            .expect("property names");
        let len = keys.length();
        let mut pairs = Vec::with_capacity(len as usize);
        for i in 0..len {
            let key = keys.get_index(scope, i).expect("key");
            let item = object.get(scope, key).expect("property");
            pairs.push((key.to_rust_string_lossy(scope), via_walker(scope, item)));
        }
        return Value::from_pairs(pairs);
    }
    Value::from(())
}
