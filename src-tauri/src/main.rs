// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use gus_assistant_lib::CliArgs;

fn main() {
    // Chrome starts this executable as the extension's native-messaging host.
    #[cfg(target_os = "macos")]
    if gus_assistant_lib::bridge::is_host_invocation() {
        gus_assistant_lib::bridge::run_host();
        return;
    }

    let cli_args = CliArgs::parse();

    #[cfg(target_os = "linux")]
    {
        // DMABUF renderer causes crashes on various GPU/display server configurations
        // See: https://github.com/tauri-apps/tauri/issues/9394
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    #[cfg(target_os = "windows")]
    {
        // Avoid overlay/capture layer crashes (#2049). Set before backend
        // initialization, preserving user overrides.
        if std::env::var_os("VK_LOADER_LAYERS_DISABLE").is_none()
            && !gus_assistant_lib::env_flag_enabled("GUS_ASSISTANT_KEEP_VULKAN_IMPLICIT_LAYERS")
        {
            std::env::set_var("VK_LOADER_LAYERS_DISABLE", "~implicit~");
        }
    }

    gus_assistant_lib::run(cli_args)
}
