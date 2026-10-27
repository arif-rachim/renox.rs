//! The serialised record and batch match the contract schema
//! `docs/contracts/schemas/meter-record.schema.json` exactly.

mod common;

use std::path::PathBuf;

use common::record;
use renox_meter::{MeterBatch, MeterRecord, MeterStatus, SCHEMA_VERSION};
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
