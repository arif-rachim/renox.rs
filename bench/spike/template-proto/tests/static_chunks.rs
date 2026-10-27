//! Consecutive static HTML is one chunk: minijinja compiles it to a single
//! `EmitRaw`, so a 500-node page is tens of instructions
//! (docs/08-template-engine.md, "Optimizations and limits").

use minijinja::Environment;
use minijinja::machinery::{Instruction, Instructions, get_compiled_template};

mod common;

fn instructions<'a>(ins: &'a Instructions<'a>) -> Vec<&'a Instruction<'a>> {
    (0..).map_while(|i| ins.get(i)).collect()
}

/// Adjacent `EmitRaw` pairs that could have been one chunk. A pair is
/// legitimate when the second one is a jump target (it starts after an
/// `{% endif %}` or a loop), because then the two run under different
/// conditions.
fn redundant_emit_raw(ins: &Instructions<'_>) -> Vec<String> {
    let list = instructions(ins);
    let targets: std::collections::HashSet<u32> = list
        .iter()
        .filter_map(|i| match i {
            Instruction::Jump(t)
            | Instruction::JumpIfFalse(t)
            | Instruction::JumpIfFalseOrPop(t)
            | Instruction::JumpIfTrueOrPop(t)
            | Instruction::Iterate(t) => Some(*t),
            _ => None,
        })
        .collect();
    list.windows(2)
        .enumerate()
        .filter(|(idx, w)| {
            matches!(w[0], Instruction::EmitRaw(_))
                && matches!(w[1], Instruction::EmitRaw(_))
                && !targets.contains(&(*idx as u32 + 1))
        })
        .map(|(_, w)| format!("{:?} | {:?}", w[0], w[1]))
        .collect()
}

#[test]
fn a_static_page_is_one_emit_raw() {
    let source = template_proto::transpile(&common::read("static-merge.html")).unwrap();
    let mut env = Environment::new();
    env.add_template_owned("static.html", source).unwrap();
    let tmpl = env.get_template("static.html").unwrap();
    let compiled = get_compiled_template(&tmpl);
    let raws = instructions(&compiled.instructions)
        .iter()
        .filter(|i| matches!(i, Instruction::EmitRaw(_)))
        .count();
    assert_eq!(
        raws, 1,
        "static page compiled to {raws} EmitRaw instructions"
    );
}

#[test]
fn shop_page_has_no_adjacent_static_chunks() {
    let env = common::env();
    let mut env = env.clone();
    let source = template_proto::transpile(&common::read("shop-products.html")).unwrap();
    env.add_template_owned("shop-products.html", source)
        .unwrap();
    for name in ["shop-products.html", "layouts/main.html"] {
        let tmpl = env.get_template(name).unwrap();
        let compiled = get_compiled_template(&tmpl);
        assert_eq!(
            redundant_emit_raw(&compiled.instructions),
            Vec::<String>::new(),
            "{name}: root"
        );
        for (block, ins) in &compiled.blocks {
            assert_eq!(
                redundant_emit_raw(ins),
                Vec::<String>::new(),
                "{name}: block {block}"
            );
        }
    }
}
