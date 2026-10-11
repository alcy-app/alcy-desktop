//! Posição e tamanho da janela principal entre aberturas do app.
//!
//! O `tauri-plugin-window-state` grava tamanho, posição e se a janela estava
//! maximizada em `.window-state.json` (na pasta de configuração do app). Ele só
//! confere se a janela intersecta algum monitor; `fit_to_work_area` completa
//! isso trazendo a janela para dentro da área útil do monitor (sem a barra de
//! tarefas) — vale para a primeira abertura, quando o tamanho padrão é maior que
//! a tela, e para um estado salvo em outro arranjo de monitores.
//!
//! A janela nasce oculta (`visible: false` no `tauri.conf.json`): o estado é
//! restaurado ainda escondido e ela só aparece quando a página termina de
//! carregar. Assim não há o flash de uma janela branca no monitor principal
//! antes de ir para a posição salva.

use std::time::Duration;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

const MAIN_WINDOW: &str = "main";

/// Só geometria: a janela não tem decoração nativa (a barra de título é do
/// app), e restaurar `DECORATIONS`/`VISIBLE` poderia religá-la ou escondê-la.
const FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/// Se a página nunca avisar que carregou, a janela aparece mesmo assim depois
/// deste prazo, para o processo não ficar rodando sem janela visível.
const SHOW_FALLBACK: Duration = Duration::from_secs(5);

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    // A restauração inicial da principal é feita em `restore_main_window`:
    // maximizar uma janela oculta a exibe no Windows, então o `MAXIMIZED` só é
    // aplicado em `show_main_window`.
    tauri_plugin_window_state::Builder::new()
        .with_state_flags(FLAGS)
        .skip_initial_state(MAIN_WINDOW)
        .build()
}

/// Grava o estado agora. O plugin já grava ao sair do app; isto cobre saídas
/// que não passam pelo fim normal do loop de eventos (ex.: o instalador de
/// atualização no Windows encerra o processo).
pub fn save<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.save_window_state(FLAGS) {
        log::warn!(target: "alcy::window", "falha ao salvar estado da janela: {error}");
    }
}

/// Restaura tamanho e posição da janela principal, ainda oculta, e a ajusta à
/// área útil do monitor em que ela ficou.
pub fn restore_main_window<R: Runtime>(app: &tauri::App<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if let Err(error) = window.restore_state(StateFlags::SIZE | StateFlags::POSITION) {
        log::warn!(target: "alcy::window", "falha ao restaurar estado da janela: {error}");
    }
    if let Err(error) = fit_to_work_area(&window) {
        log::warn!(target: "alcy::window", "falha ao ajustar a janela à área útil: {error}");
    }

    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_FALLBACK);
        show_main_window(&handle);
    });
}

/// Exibe a janela principal na primeira vez que é chamada (as seguintes não
/// fazem nada), já maximizada se ela foi fechada assim.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if window.is_visible().unwrap_or(true) {
        return;
    }
    // No Windows, maximizar a janela oculta já a exibe maximizada, sem passar
    // pelo tamanho normal antes.
    if let Err(error) = window.restore_state(StateFlags::MAXIMIZED) {
        log::warn!(target: "alcy::window", "falha ao restaurar maximização da janela: {error}");
    }
    if let Err(error) = window.show().and_then(|()| window.set_focus()) {
        log::warn!(target: "alcy::window", "falha ao exibir a janela: {error}");
    }
}

fn fit_to_work_area<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    if window.is_maximized()? {
        return Ok(());
    }
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let area = monitor.work_area();
    let position = window.outer_position()?;
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;

    let current = Rect {
        x: position.x,
        y: position.y,
        width: outer.width,
        height: outer.height,
    };
    let bounds = Rect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width,
        height: area.size.height,
    };
    let fitted = fit_rect(current, bounds);
    if fitted == current {
        return Ok(());
    }

    if (fitted.width, fitted.height) != (current.width, current.height) {
        // `set_size` define o tamanho interno; desconta a borda, se houver.
        let border_width = outer.width.saturating_sub(inner.width);
        let border_height = outer.height.saturating_sub(inner.height);
        window.set_size(PhysicalSize::new(
            fitted.width.saturating_sub(border_width),
            fitted.height.saturating_sub(border_height),
        ))?;
    }
    window.set_position(PhysicalPosition::new(fitted.x, fitted.y))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Encolhe `window` até caber em `bounds` e a desloca para dentro dele.
fn fit_rect(window: Rect, bounds: Rect) -> Rect {
    let width = window.width.min(bounds.width);
    let height = window.height.min(bounds.height);
    let max_x = bounds.x.saturating_add_unsigned(bounds.width - width);
    let max_y = bounds.y.saturating_add_unsigned(bounds.height - height);
    Rect {
        x: window.x.clamp(bounds.x, max_x),
        y: window.y.clamp(bounds.y, max_y),
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK_AREA: Rect = Rect {
        x: 0,
        y: 0,
        width: 1366,
        height: 728,
    };

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn keeps_window_that_already_fits() {
        let window = rect(100, 50, 1000, 600);
        assert_eq!(fit_rect(window, WORK_AREA), window);
    }

    #[test]
    fn shrinks_window_taller_than_work_area() {
        assert_eq!(
            fit_rect(rect(40, 0, 1280, 800), WORK_AREA),
            rect(40, 0, 1280, 728)
        );
    }

    #[test]
    fn moves_window_whose_bottom_is_under_the_taskbar() {
        assert_eq!(
            fit_rect(rect(40, 100, 1280, 700), WORK_AREA),
            rect(40, 28, 1280, 700)
        );
    }

    #[test]
    fn moves_window_back_from_off_screen_top_left() {
        assert_eq!(
            fit_rect(rect(-300, -50, 1000, 600), WORK_AREA),
            rect(0, 0, 1000, 600)
        );
    }

    #[test]
    fn respects_work_area_offset_on_secondary_monitor() {
        let secondary = rect(1920, 40, 1920, 1000);
        assert_eq!(
            fit_rect(rect(3000, 500, 1280, 800), secondary),
            rect(2560, 240, 1280, 800)
        );
    }
}
