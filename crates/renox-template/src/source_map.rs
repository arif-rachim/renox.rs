//! Line markers: where each part of a compiled template came from.
//!
//! The compiler inlines components, so a line of `templates/<id>.jinja` is
//! not a line of the file the tenant wrote. It leaves a marker, a minijinja
//! comment `{#@ <file id>:<line> #}`, before code that came from another
//! place, and the renderer maps a compiled `(template, line)` to the file
//! and line by the nearest marker. A comment renders nothing and holds no
//! newline, so line numbers of the compiled text do not move (#682).

const OPEN: &str = "{#@ ";
const CLOSE: &str = " #}";

/// A place in the compiler's output (`offset`, a byte offset) and the
/// location in the tenant's files of the code that starts there.
pub(crate) struct Mark {
    pub offset: usize,
    pub file: String,
    pub line: usize,
}

/// The id of a template file: `partials/grid.html` is `partials/grid`.
fn id_of(file: &str) -> &str {
    file.strip_suffix(".html").unwrap_or(file)
}

/// Writes the markers (offsets ascending) into `out`. A marker is written
/// only where code (`{%` or `{{`) follows before the next mark, so static
/// HTML stays one chunk, and not when the previous written marker says the
/// same.
pub(crate) fn insert(out: String, marks: &[Mark]) -> String {
    let mut result = String::with_capacity(out.len());
    let mut done = 0;
    let mut last: Option<(&str, usize)> = None;
    for (i, mark) in marks.iter().enumerate() {
        let end = marks.get(i + 1).map_or(out.len(), |m| m.offset);
        let region = &out[mark.offset..end];
        if !(region.contains("{%") || region.contains("{{")) {
            continue;
        }
        let id = id_of(&mark.file);
        if last == Some((id, mark.line)) {
            continue;
        }
        result.push_str(&out[done..mark.offset]);
        result.push_str(&format!("{OPEN}{id}:{}{CLOSE}", mark.line));
        done = mark.offset;
        last = Some((id, mark.line));
    }
    result.push_str(&out[done..]);
    result
}

/// One marker found in a compiled template.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    /// The compiled line the marker is on (1-based).
    compiled: u32,
    id: String,
    line: u32,
}

/// The markers of a compiled template, in order.
pub(crate) fn parse(text: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut line = 1u32;
    let mut from = 0;
    while let Some(rel) = text[from..].find(OPEN) {
        let at = from + rel;
        line += text[from..at].matches('\n').count() as u32;
        let body = &text[at + OPEN.len()..];
        if let Some(end) = body.find(CLOSE)
            && let Some((id, n)) = body[..end].rsplit_once(':')
            && let Ok(n) = n.parse()
        {
            entries.push(Entry {
                compiled: line,
                id: id.to_string(),
                line: n,
            });
        }
        from = at + OPEN.len();
    }
    entries
}

/// Maps a compiled line to the file id and line it came from: the first
/// marker on that line (code starts where a marker is), else the nearest
/// one before it. `None` without a marker before the line.
pub(crate) fn locate(entries: &[Entry], line: u32) -> Option<(&str, u32)> {
    let on_line = entries.iter().find(|e| e.compiled == line);
    let found = on_line.or_else(|| entries.iter().rev().find(|e| e.compiled < line))?;
    Some((found.id.as_str(), found.line))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mark(offset: usize, file: &str, line: usize) -> Mark {
        Mark {
            offset,
            file: file.into(),
            line,
        }
    }

    #[test]
    fn markers_only_before_code_and_not_repeated() {
        let out = "<p>a</p>{% if x %}b{% endif %}\n<i>{{ y }}</i>".to_string();
        let marks = [
            mark(0, "pages/index.html", 1),
            mark(8, "pages/index.html", 1),
            mark(31, "pages/index.html", 1),
        ];
        assert_eq!(
            insert(out, &marks),
            "<p>a</p>{#@ pages/index:1 #}{% if x %}b{% endif %}\n<i>{{ y }}</i>"
        );
    }

    #[test]
    fn static_text_has_no_markers() {
        let out = "<p>a</p>".to_string();
        assert_eq!(insert(out.clone(), &[mark(0, "pages/index.html", 1)]), out);
    }

    #[test]
    fn locates_by_the_nearest_marker() {
        let text = "{#@ pages/index:2 #}{% x %}\nplain\n{#@ partials/grid:3 #}{% y %}\n{% z %}";
        let entries = parse(text);
        assert_eq!(locate(&entries, 1), Some(("pages/index", 2)));
        assert_eq!(locate(&entries, 2), Some(("pages/index", 2)));
        assert_eq!(locate(&entries, 3), Some(("partials/grid", 3)));
        assert_eq!(locate(&entries, 4), Some(("partials/grid", 3)));
        assert_eq!(locate(&parse("{% x %}"), 1), None);
    }
}
