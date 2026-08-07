//! Version-locked binding generator.
//!
//! Exists so the bindings are produced by the same `uniffi` release that built
//! the scaffolding in `lib.rs`. See the `[[bin]]` comment in `Cargo.toml`.

fn main() {
    uniffi::uniffi_bindgen_main()
}
