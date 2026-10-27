//! Issue #10 acceptance: the four marshaling paths (and the extra fifth) produce the same
//! `minijinja::Value`, and that value renders the same in a template.

use marshal_bench::{
    Sandbox, via_json_string, via_json_string_struct, via_serde_json, via_struct, via_walker,
};
use minijinja::{Environment, Value, context};

/// Renders every field so the comparison also covers how values print
/// (an integer-valued float would print `3.0` on one path and `3` on another).
const TEMPLATE: &str = "{% for p in items %}{{ p.id }}|{{ p.name }}|{{ p.slug }}|{{ p.price }}|\
{{ p.stock }}|{{ p.image }}|{{ p.category }}|{{ p.rating }}|{{ p.featured }}|\
{{ p.seller.id }}|{{ p.seller.name }}|{{ p.seller.currency }}\n{% endfor %}";

fn render(items: &Value) -> String {
    let mut env = Environment::new();
    env.add_template("t", TEMPLATE).unwrap();
    env.get_template("t")
        .unwrap()
        .render(context! { items => items })
        .unwrap()
}

#[test]
fn all_paths_produce_the_same_value() {
    let mut sandbox = Sandbox::new();
    for n in [0, 1, 10, 100] {
        let values = sandbox.with_products(n, |scope, products| {
            [
                via_serde_json(scope, products),
                via_struct(scope, products),
                via_walker(scope, products),
                via_json_string(scope, products),
                via_json_string_struct(scope, products),
            ]
        });
        assert_eq!(values[0].len(), Some(n));
        let rendered = render(&values[0]);
        assert_eq!(rendered.lines().count(), n);
        for (i, v) in values.iter().enumerate() {
            assert_eq!(v, &values[0], "path {} differs at n = {n}", i + 1);
            assert_eq!(
                render(v),
                rendered,
                "path {} renders differently at n = {n}",
                i + 1
            );
        }
    }
}

#[test]
fn sample_values_have_the_expected_types() {
    let mut sandbox = Sandbox::new();
    let v = sandbox.with_products(3, via_walker);
    let first = v.get_item_by_index(0).unwrap();
    assert_eq!(first.get_attr("id").unwrap().as_str(), Some("p000"));
    assert_eq!(first.get_attr("stock").unwrap().as_i64(), Some(0));
    assert!(first.get_attr("featured").unwrap().is_true());
    assert_eq!(
        f64::try_from(first.get_attr("price").unwrap()).unwrap(),
        19.99
    );
    let seller = first.get_attr("seller").unwrap();
    assert_eq!(seller.get_attr("currency").unwrap().as_str(), Some("AED"));
}
