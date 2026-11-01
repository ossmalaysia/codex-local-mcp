use anyhow::Result;
use std::path::Path;
use windows::{
    Win32::{
        Foundation::PROPERTYKEY,
        System::Com::{
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
            CoUninitialize, IPersistFile, STGM_READWRITE, StructuredStorage::PROPVARIANT,
        },
        UI::Shell::{
            IShellLinkW, PropertiesSystem::IPropertyStore, SetCurrentProcessExplicitAppUserModelID,
            ShellLink,
        },
    },
    core::{Interface, PCWSTR, w},
};
const ID: &str = "com.ossmalaysia.codex-local-mcp";
pub fn register(install: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    // Only repair the app's existing shortcut. Isolated test folders create no shortcuts.
    let shortcut = std::path::PathBuf::from(
        std::env::var_os("APPDATA")
            .ok_or_else(|| anyhow::anyhow!("Windows application data is unavailable"))?,
    )
    .join("Microsoft/Windows/Start Menu/Programs/Codex Local MCP.lnk");
    if !shortcut.is_file() {
        return Ok(());
    }
    codex_mcp_platform::secure::no_links(&shortcut)?;
    let path: Vec<u16> = shortcut.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: COM stays on this STA thread. Interface wrappers own their references.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _apartment = Apartment;
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        file.Load(PCWSTR(path.as_ptr()), STGM_READWRITE)?;
        let mut target = [0u16; 32768];
        link.GetPath(&mut target, std::ptr::null_mut(), 0)?;
        let length = target.iter().position(|c| *c == 0).unwrap_or(target.len());
        if !String::from_utf16_lossy(&target[..length])
            .eq_ignore_ascii_case(&install.join("CodexMCP.exe").to_string_lossy())
        {
            return Ok(());
        }
        let properties: IPropertyStore = link.cast()?;
        let key = PROPERTYKEY {
            fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
            pid: 5,
        };
        properties.SetValue(&key, &PROPVARIANT::from(ID))?;
        properties.Commit()?;
        file.Save(PCWSTR(path.as_ptr()), true)?;
        SetCurrentProcessExplicitAppUserModelID(w!("com.ossmalaysia.codex-local-mcp"))?;
    }
    let icon = codex_mcp_platform::secure::root()?.join("notification-icon.png");
    codex_mcp_platform::secure::atomic(
        &icon,
        include_bytes!("../../../installer/windows/Manager/Assets/logo.png"),
    )?;
    let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .create_subkey(format!(r"Software\Classes\AppUserModelId\{ID}"))?;
    key.set_value("DisplayName", &"Codex Local MCP")?;
    key.set_value("IconUri", &icon.to_string_lossy().as_ref())?;
    key.set_value(
        "ApplicationPath",
        &install.join("CodexMCP.exe").to_string_lossy().as_ref(),
    )?;
    Ok(())
}
