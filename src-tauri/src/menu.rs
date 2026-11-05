//! macOS menu bar, localised.
//!
//! Tauri's default menu hardcodes English titles ("About", "Hide Others",
//! "Quit", ...). The items themselves are the standard predefined ones — only
//! their text is replaced — so the shortcuts and behaviour are unchanged.
//! The frontend calls `set_app_menu` whenever the UI language is resolved or
//! changed (see App.tsx), which rebuilds and swaps the whole menu.
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const SUPPORT_ID: &str = "support";

/// Where the "support" menu item points; refreshed with every `set_app_menu`
/// so it always matches the current language's `settings.supportUrl`.
static SUPPORT_URL: Mutex<String> = Mutex::new(String::new());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuLabels {
    about: String,
    support: String,
    support_url: String,
    services: String,
    hide: String,
    hide_others: String,
    quit: String,
    file: String,
    close_window: String,
    edit: String,
    undo: String,
    redo: String,
    cut: String,
    copy: String,
    paste: String,
    select_all: String,
    view: String,
    fullscreen: String,
    window: String,
    minimize: String,
    maximize: String,
    help: String,
}

fn build(app: &AppHandle, l: &MenuLabels) -> tauri::Result<Menu<tauri::Wry>> {
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        &app.package_info().name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&l.about), None)?,
            &MenuItem::with_id(app, SUPPORT_ID, &l.support, true, None::<&str>)?,
            &sep()?,
            &PredefinedMenuItem::services(app, Some(&l.services))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some(&l.hide))?,
            &PredefinedMenuItem::hide_others(app, Some(&l.hide_others))?,
            &sep()?,
            &PredefinedMenuItem::quit(app, Some(&l.quit))?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        &l.file,
        true,
        &[&PredefinedMenuItem::close_window(app, Some(&l.close_window))?],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        &l.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&l.undo))?,
            &PredefinedMenuItem::redo(app, Some(&l.redo))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some(&l.cut))?,
            &PredefinedMenuItem::copy(app, Some(&l.copy))?,
            &PredefinedMenuItem::paste(app, Some(&l.paste))?,
            &PredefinedMenuItem::select_all(app, Some(&l.select_all))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        &l.view,
        true,
        &[&PredefinedMenuItem::fullscreen(app, Some(&l.fullscreen))?],
    )?;
    let window_menu = Submenu::with_items(
        app,
        &l.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&l.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(&l.maximize))?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, Some(&l.close_window))?,
        ],
    )?;
    let help_menu = Submenu::with_items(app, &l.help, true, &[])?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    window_menu.set_as_windows_menu_for_nsapp()?;
    help_menu.set_as_help_menu_for_nsapp()?;
    Ok(menu)
}

/// Tauri command: replaces the menu bar with one using the given titles.
#[tauri::command]
pub fn set_app_menu(app: AppHandle, labels: MenuLabels) -> Result<(), String> {
    // AppKit menus must be touched on the main thread; Tauri commands run on
    // a worker thread by default.
    *SUPPORT_URL.lock().unwrap() = labels.support_url.clone();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Ok(menu) = build(&handle, &labels) {
            let _ = handle.set_menu(menu);
        }
    })
    .map_err(|e| e.to_string())
}

/// Opens the support page when its menu item is chosen. The menu is rebuilt
/// on language changes, but this handler is app-wide so it only needs
/// registering once.
pub fn install(app: &AppHandle) {
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == SUPPORT_ID {
            let url = SUPPORT_URL.lock().unwrap().clone();
            if !url.is_empty() {
                let _ = app.opener().open_url(url, None::<&str>);
            }
        }
    });
}
