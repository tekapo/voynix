//! macOS Dock right-click menu (Play/Pause, Next, Previous, Thumbs Up/Down).
//!
//! Neither Tauri nor tao exposes `applicationDockMenu:`, so we add it (and the
//! menu-item action) to tao's app delegate class at runtime. Item clicks are
//! forwarded to the frontend as a `dock-action` event whose payload is
//! "toggle" | "next" | "previous" | "like" | "dislike".
//!
//! Item titles are translated in the frontend (src/i18n) and pushed down via
//! `set_dock_labels` (see App.tsx's language-change effect) rather than
//! hardcoded here — `dock_menu` reads whatever LABELS currently holds each
//! time the menu is (re)built, so a language change takes effect on the next
//! right-click with no restart needed.
use std::sync::{Mutex, OnceLock};

use objc2::ffi;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSControlStateValueOff, NSControlStateValueOn, NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Action names, in Dock-menu order — stable regardless of language, since
/// they're also the `dock-action` event payload the frontend matches on.
const ACTIONS: [&str; 5] = ["toggle", "next", "previous", "like", "dislike"];

/// Current menu-item titles, indexed the same as `ACTIONS`. English until the
/// frontend's initial language-resolution effect calls `set_dock_labels`.
static LABELS: Mutex<[String; 5]> = Mutex::new([
    String::new(),
    String::new(),
    String::new(),
    String::new(),
    String::new(),
]);

/// State of the playing track's rating, shown as checkmarks / enabled state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DockRating {
    has_track: bool,
    liked: bool,
    disliked: bool,
}

impl DockRating {
    const NONE: DockRating = DockRating { has_track: false, liked: false, disliked: false };
}

static RATING: Mutex<DockRating> = Mutex::new(DockRating::NONE);

/// `(enabled, checked)` for a rating item, or `None` for the transport items
/// (which are always enabled and never checked).
fn rating_item_state(action: &str, rating: DockRating) -> Option<(bool, bool)> {
    let checked = match action {
        "like" => rating.liked,
        "dislike" => rating.disliked,
        _ => return None,
    };
    Some((rating.has_track, checked))
}

fn default_labels() -> [String; 5] {
    ["Play/Pause", "Next", "Previous", "Thumbs Up", "Thumbs Down"].map(String::from)
}

fn current_labels() -> [String; 5] {
    let guard = LABELS.lock().unwrap();
    if guard[0].is_empty() {
        default_labels()
    } else {
        guard.clone()
    }
}

/// Tauri command: replaces the Dock menu's item titles. `labels` must be
/// `[toggle, next, previous, like, dislike]`, matching `ACTIONS`'s order.
#[tauri::command]
pub fn set_dock_labels(labels: [String; 5]) {
    *LABELS.lock().unwrap() = labels;
}

/// Tauri command: tells the Dock menu about the playing track's rating so the
/// next right-click shows checkmarks (and disables the items with no track).
#[tauri::command]
pub fn set_dock_rating(has_track: bool, liked: bool, disliked: bool) {
    *RATING.lock().unwrap() = DockRating { has_track, liked, disliked };
}

extern "C" fn dock_menu(_this: &AnyObject, _sel: Sel, _sender: &AnyObject) -> *mut NSMenu {
    let mtm = MainThreadMarker::new().expect("applicationDockMenu: runs on the main thread");
    let menu = NSMenu::new(mtm);
    // Items are enabled/disabled explicitly below, not by responder-chain lookup.
    menu.setAutoenablesItems(false);
    let labels = current_labels();
    let rating = *RATING.lock().unwrap();
    for (tag, title) in labels.iter().enumerate() {
        // The rating items start after a separator.
        if ACTIONS[tag] == "like" {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
        }
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                Some(sel!(voynixDockAction:)),
                &NSString::from_str(""),
            )
        };
        item.setTag(tag as isize);
        if let Some((enabled, checked)) = rating_item_state(ACTIONS[tag], rating) {
            item.setEnabled(enabled);
            item.setState(if checked { NSControlStateValueOn } else { NSControlStateValueOff });
        }
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

/// Call after the app is built (tao registers its delegate class then) and
/// before `run`.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(cls) = AnyClass::get(c"TaoAppDelegateParent")
    else {
        eprintln!("dock menu: TaoAppDelegateParent not found");
        return;
    };
    let cls = cls as *const AnyClass as *mut AnyClass;
    unsafe {
        type MenuFn = extern "C" fn(&AnyObject, Sel, &AnyObject) -> *mut NSMenu;
        type ActionFn = extern "C" fn(&AnyObject, Sel, &NSMenuItem);
        let menu_imp: MenuFn = dock_menu;
        let action_imp: ActionFn = dock_action;
        // Type encodings: "@@:@" = returns object, (self, _cmd, id); "v@:@" = void.
        // `class_addMethod` returns NO (false) if the class already has a
        // method for that selector, or the selector name is malformed — not
        // expected here, but worth surfacing rather than silently leaving the
        // Dock menu absent with no clue why.
        if !ffi::class_addMethod(
            cls,
            sel!(applicationDockMenu:),
            std::mem::transmute::<MenuFn, Imp>(menu_imp),
            c"@@:@".as_ptr(),
        )
        .as_bool()
        {
            eprintln!("dock menu: class_addMethod(applicationDockMenu:) failed");
        }
        if !ffi::class_addMethod(
            cls,
            sel!(voynixDockAction:),
            std::mem::transmute::<ActionFn, Imp>(action_imp),
            c"v@:@".as_ptr(),
        )
        .as_bool()
        {
            eprintln!("dock menu: class_addMethod(voynixDockAction:) failed");
        }
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

        let ja = ["再生/一時停止", "次へ", "前へ", "高評価", "低評価"].map(String::from);
        set_dock_labels(ja.clone());
        assert_eq!(current_labels(), ja);

        // Restore English so this doesn't leak into another test in the same run.
        set_dock_labels(default_labels());
        assert_eq!(current_labels(), default_labels());
    }

    #[test]
    fn set_dock_rating_updates_what_the_menu_reads() {
        set_dock_rating(true, false, true);
        assert_eq!(
            *RATING.lock().unwrap(),
            DockRating { has_track: true, liked: false, disliked: true }
        );
        set_dock_rating(false, false, false);
        assert_eq!(*RATING.lock().unwrap(), DockRating::NONE);
    }

    #[test]
    fn rating_item_state_enables_with_a_track_and_checks_only_the_active_rating() {
        let liked = DockRating { has_track: true, liked: true, disliked: false };
        assert_eq!(rating_item_state("like", liked), Some((true, true)));
        assert_eq!(rating_item_state("dislike", liked), Some((true, false)));

        let disliked = DockRating { has_track: true, liked: false, disliked: true };
        assert_eq!(rating_item_state("like", disliked), Some((true, false)));
        assert_eq!(rating_item_state("dislike", disliked), Some((true, true)));

        // No track: both disabled and unchecked.
        assert_eq!(rating_item_state("like", DockRating::NONE), Some((false, false)));
        assert_eq!(rating_item_state("dislike", DockRating::NONE), Some((false, false)));

        // Transport items aren't rating items.
        assert_eq!(rating_item_state("toggle", liked), None);
    }
}
