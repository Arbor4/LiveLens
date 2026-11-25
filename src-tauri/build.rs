fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/apple_vision.m");
        cc::Build::new()
            .file("native/apple_vision.m")
            .flag("-fobjc-arc")
            .compile("livelens_apple_vision");
        println!("cargo:rustc-link-lib=framework=Vision");
        println!("cargo:rustc-link-lib=framework=ImageIO");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }

    tauri_build::build()
}
