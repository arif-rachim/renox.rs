//! The serialised record and batch match the contract schema
//! `docs/contracts/schemas/meter-record.schema.json` exactly.

mod common;

use std::path::PathBuf;

use common::record;
use renox_meter::{MeterBatch, MeterKind, MeterRecord, MeterStatus, SCHEMA_VERSION};
use serde_json::Value;

fn contracts() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts")
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn validator() -> jsonschema::Validator {
    jsonschema::validator_for(&read_json(
        contracts().join("schemas/meter-record.schema.json"),
    ))
    .expect("contract schema compiles")
}

fn batch(records: Vec<MeterRecord>) -> MeterBatch {
    MeterBatch {
        schema_version: SCHEMA_VERSION,
        cell_id: "t_notes@node-dxb-01".into(),
        node_id: "node-dxb-01".into(),
        records,
    }
}

fn errors(v: &jsonschema::Validator, value: &Value) -> Vec<String> {
    v.iter_errors(value).map(|e| e.to_string()).collect()
}

#[test]
fn serialised_batch_validates_against_the_contract_schema() {
    let v = validator();
    let statuses = [
        MeterStatus::Ok,
        MeterStatus::Error,
        MeterStatus::Timeout,
        MeterStatus::CpuLimit,
        MeterStatus::Oom,
        MeterStatus::BlockedFetch,
        MeterStatus::Busy,
        MeterStatus::RenderLimit,
    ];
    let records = statuses
        .iter()
        .enumerate()
        .map(|(n, s)| MeterRecord {
            status: *s,
            ..record(n as u64)
        })
        .collect();
    let value = serde_json::to_value(batch(records)).unwrap();
    assert_eq!(errors(&v, &value), Vec::<String>::new());
}

#[test]
fn serialised_field_names_are_exactly_the_schema_fields() {
    let schema = read_json(contracts().join("schemas/meter-record.schema.json"));
    let mut required: Vec<String> = schema["$defs"]["record"]["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap().to_owned())
        .collect();
    let value = serde_json::to_value(record(1)).unwrap();
    let mut fields: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
    required.sort();
    fields.sort();
    assert_eq!(fields, required);
}

/// Contract 0.1: a record of a rendered page carries `render_fuel` and the
/// optional `render_ms`; a record without a render omits `render_ms`.
#[test]
fn render_fields_validate_and_render_ms_is_optional() {
    let v = validator();
    let rendered = MeterRecord {
        render_fuel: 4_770,
        render_ms: Some(0.32449),
        ..record(1)
    };
    let value = serde_json::to_value(batch(vec![rendered.clone(), record(2)])).unwrap();
    assert_eq!(errors(&v, &value), Vec::<String>::new());
    assert_eq!(value["records"][0]["render_ms"], serde_json::json!(0.324));
    assert!(value["records"][1].get("render_ms").is_none());
    let back: MeterRecord = serde_json::from_value(value["records"][1].clone()).unwrap();
    assert_eq!(back.render_ms, None);
}

/// Contract 0.2 (#231): an event delivery record carries `kind: "event"`
/// and the `EVENT <module> <name>` route; a request record may not use that
/// route form, and an event record may not use a `<METHOD>` route.
#[test]
fn event_records_validate_and_route_form_follows_kind() {
    let v = validator();
    let event = MeterRecord {
        kind: Some(MeterKind::Event),
        authz_evals: None,
        realtime_conn_seconds: None,
        realtime_messages: None,
        storage_bytes: None,
        image_variants: None,
        ai_tokens_in: None,
        ai_tokens_out: None,
        render_pdf_ms: None,
        route: "EVENT email billing.invoice_paid".into(),
        request_id: "01JBQ3Z7MA0000000000000001_email_1".into(),
        ingress_bytes: 0,
        egress_bytes: 0,
        ..record(1)
    };
    let value = serde_json::to_value(batch(vec![event.clone()])).unwrap();
    assert_eq!(errors(&v, &value), Vec::<String>::new());
    assert_eq!(value["records"][0]["kind"], "event");
    assert!(
        serde_json::to_value(record(2))
            .unwrap()
            .get("kind")
            .is_none()
    );
    let wrong_route = MeterRecord {
        route: "GET /x".into(),
        ..event.clone()
    };
    let as_request = MeterRecord {
        kind: None,
        authz_evals: None,
        realtime_conn_seconds: None,
        realtime_messages: None,
        storage_bytes: None,
        image_variants: None,
        ai_tokens_in: None,
        ai_tokens_out: None,
        render_pdf_ms: None,
        ..event
    };
    for r in [wrong_route, as_request] {
        let value = serde_json::to_value(batch(vec![r])).unwrap();
        assert!(!errors(&v, &value).is_empty());
    }
}

#[test]
fn millisecond_fields_are_rounded_to_three_decimals() {
    let value = serde_json::to_value(MeterRecord {
        cpu_ms: -1.0,
        ..record(1)
    })
    .unwrap();
    assert_eq!(
        value["cpu_ms"],
        serde_json::json!(0.0),
        "negative clamps to 0"
    );
    let value = serde_json::to_value(record(1)).unwrap();
    assert_eq!(value["cpu_ms"], serde_json::json!(1.482));
    assert_eq!(value["wall_ms"], serde_json::json!(3.917));
    assert_eq!(value["db_ms"], serde_json::json!(0.211));
}

#[test]
fn contract_example_batch_round_trips() {
    let v = validator();
    let example = read_json(contracts().join("examples/meter-batch.json"));
    let parsed: MeterBatch = serde_json::from_value(example.clone()).expect("example parses");
    let again = serde_json::to_value(&parsed).unwrap();
    assert_eq!(errors(&v, &again), Vec::<String>::new());
    // 0 and 0.0 are the same JSON number to the schema; compare as values.
    assert_eq!(serde_json::from_value::<MeterBatch>(again).unwrap(), parsed);
    assert_eq!(
        parsed.records.len(),
        example["records"].as_array().unwrap().len()
    );
}

#[test]
fn contract_invalid_examples_are_rejected() {
    let v = validator();
    let dir = contracts().join("examples/meter");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        // The folder also holds valid examples (`*.valid.json`, #152).
        if !name.ends_with(".invalid.json") {
            continue;
        }
        // Duplicate request ids are rule M1 in validate.ts, not a schema rule.
        if name.contains("duplicate-request-id") {
            continue;
        }
        let value = read_json(path);
        assert!(!v.is_valid(&value), "{name} must be rejected by the schema");
        checked += 1;
    }
    assert!(checked >= 3);
}

#[test]
fn contract_valid_examples_are_accepted() {
    let v = validator();
    let dir = contracts().join("examples/meter");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if !name.ends_with(".valid.json") {
            continue;
        }
        let value = read_json(path);
        let errs = errors(&v, &value);
        assert!(errs.is_empty(), "{name} must validate: {errs:?}");
        checked += 1;
    }
    assert!(checked >= 1);
}
