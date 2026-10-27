//! `cargo run -p template-proto --example transpile < file.html` prints the
//! minijinja source (or the diagnostics) for one template.
use std::io::Read;

fn main() {
    let mut html = String::new();
    std::io::stdin()
        .read_to_string(&mut html)
        .expect("read stdin");
    match template_proto::compile(&html) {
        Ok(out) => {
            print!("{}", out.source);
            for (fragment, block) in out.fragments {
                eprintln!("fragment {fragment} -> block {block}");
            }
        }
        Err(diags) => {
            for d in diags {
                eprintln!("{d}");
            }
            std::process::exit(1);
        }
    }
}
