//! macOS Dock right-click menu (Play/Pause, Next, Previous).
//!
//! Neither Tauri nor tao exposes `applicationDockMenu:`, so we add it (and the
//! menu-item action) to tao's app delegate class at runtime. Item clicks are
//! forwarded to the frontend as a `dock-action` event whose payload is
//! "toggle" | "next" | "previous".
//!
//! Item titles are translated in the frontend (src/i18n) and pushed down via
//! `set_dock_labels` (see App.tsx's language-change effect) rather than
//! hardcoded here — `dock_menu` reads whatever LABELS currently holds each
//! time the menu is (re)built, so a language change takes effect on the next
//! right-click with no restart needed.
use std::ffi::CStr;
use std::sync::{Mutex, OnceLock};

use objc2::ffi;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Action names, in Dock-menu order — stable regardless of language, since
/// they're also the `dock-action` event payload the frontend matches on.
const ACTIONS: [&str; 3] = ["toggle", "next", "previous"];

/// Current menu-item titles, indexed the same as `ACTIONS`. English until the
/// frontend's initial language-resolution effect calls `set_dock_labels`.
static LABELS: Mutex<[String; 3]> = Mutex::new([
    String::new(),
    String::new(),
    String::new(),
]);

fn default_labels() -> [String; 3] {
    ["Play/Pause".to_string(), "Next".to_string(), "Previous".to_string()]
}

fn current_labels() -> [String; 3] {
    let guard = LABELS.lock().unwrap();
    if guard[0].is_empty() {
        default_labels()
    } else {
        guard.clone()
    }
}

/// Tauri command: replaces the Dock menu's item titles. `labels` must be
/// `[toggle, next, previous]`, matching `ACTIONS`'s order.
#[tauri::command]
pub fn set_dock_labels(labels: [String; 3]) {
    *LABELS.lock().unwrap() = labels;
}

extern "C" fn dock_menu(_this: &AnyObject, _sel: Sel, _sender: &AnyObject) -> *mut NSMenu {
    let mtm = MainThreadMarker::new().expect("applicationDockMenu: runs on the main thread");
    let menu = NSMenu::new(mtm);
    let labels = current_labels();
    for (tag, title) in labels.iter().enumerate() {
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                Some(sel!(voynixDockAction:)),
                &NSString::from_str(""),
            )
        };
        item.setTag(tag as isize);
        // Leave the target nil: the action travels the responder chain to
        // NSApp's delegate, which is where `voynixDockAction:` is installed.
        menu.addItem(&item);
    }
    Retained::autorelease_return(menu)
}

extern "C" fn dock_action(_this: &AnyObject, _sel: Sel, sender: &NSMenuItem) {
    let Some(name) = ACTIONS.get(sender.tag() as usize) else {
        return;
    };
    if let Some(app) = APP.get() {
        let _ = app.emit("dock-action", *name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Single test, not split up: LABELS is a process-wide static, so parallel
    // tests touching it would race. (`install()`/the Cocoa half needs a real
    // main-thread app delegate and isn't exercised here.)
    #[test]
    fn set_dock_labels_updates_what_the_menu_reads_and_falls_back_to_english_untouched() {
        assert_eq!(current_labels(), default_labels());

        set_dock_labels(["再生/一時停止".to_string(), "次へ".to_string(), "前へ".to_string()]);
        assert_eq!(
            current_labels(),
            ["再生/一時停止".to_string(), "次へ".to_string(), "前へ".to_string()]
        );

        // Restore English so this doesn't leak into another test in the same run.
        set_dock_labels(default_labels());
        assert_eq!(current_labels(), default_labels());
    }
}

/// Call after the app is built (tao registers its delegate class then) and
/// before `run`.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(cls) = AnyClass::get(CStr::from_bytes_with_nul(b"TaoAppDelegateParent\0").unwrap())
    else {
        eprintln!("dock menu: TaoAppDelegateParent not found");
        return;
    };
    let cls = cls as *const AnyClass as *mut AnyClass;
    unsafe {
        let menu_imp: extern "C" fn(&AnyObject, Sel, &AnyObject) -> *mut NSMenu = dock_menu;
        let action_imp: extern "C" fn(&AnyObject, Sel, &NSMenuItem) = dock_action;
        // Type encodings: "@@:@" = returns object, (self, _cmd, id); "v@:@" = void.
        // `class_addMethod` returns NO (false) if the class already has a
        // method for that selector, or the selector name is malformed — not
        // expected here, but worth surfacing rather than silently leaving the
        // Dock menu absent with no clue why.
        if !ffi::class_addMethod(
            cls,
            sel!(applicationDockMenu:),
            std::mem::transmute::<_, Imp>(menu_imp),
            c"@@:@".as_ptr(),
        )
        .as_bool()
        {
            eprintln!("dock menu: class_addMethod(applicationDockMenu:) failed");
        }
        if !ffi::class_addMethod(
            cls,
            sel!(voynixDockAction:),
            std::mem::transmute::<_, Imp>(action_imp),
            c"v@:@".as_ptr(),
        )
        .as_bool()
        {
            eprintln!("dock menu: class_addMethod(voynixDockAction:) failed");
        }
    }
}
