//! Ordem das gravações de arquivo inteiro disparadas pelo autosave
//! (coleções, flows).
//!
//! Esses commands rodam a escrita em `spawn_blocking`, fora da thread
//! principal. Sem coordenação, duas gravações seguidas do mesmo arquivo
//! poderiam terminar fora de ordem, e a mais antiga sobrescreveria a mais
//! nova. Cada chamada pega um número de ordem (`ticket`) ao entrar no
//! command. A escrita roda sob um lock, e uma gravação cujo ticket é
//! anterior ao da última já gravada para o mesmo arquivo é descartada,
//! porque o disco já tem um estado mais novo.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct OrderedSaves {
    next_ticket: AtomicU64,
    /// Último ticket gravado por raiz de workspace. Poucas entradas (um
    /// workspace aberto por vez), então um `Vec` basta.
    latest: Mutex<Vec<(PathBuf, u64)>>,
}

impl OrderedSaves {
    pub const fn new() -> Self {
        Self {
            next_ticket: AtomicU64::new(0),
            latest: Mutex::new(Vec::new()),
        }
    }

    /// Número de ordem de uma gravação; tirado na entrada do command, antes
    /// de qualquer `await`.
    pub fn ticket(&self) -> u64 {
        self.next_ticket.fetch_add(1, Ordering::Relaxed)
    }

    /// Executa `write` para `root`, a menos que uma gravação com ticket
    /// posterior já tenha sido feita para a mesma raiz. Nesse caso devolve
    /// `Ok(())` sem escrever.
    pub fn run<E>(
        &self,
        ticket: u64,
        root: &Path,
        write: impl FnOnce() -> Result<(), E>,
    ) -> Result<(), E> {
        let mut latest = self
            .latest
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let position = latest.iter().position(|(path, _)| path == root);
        if let Some(index) = position
            && latest[index].1 > ticket
        {
            return Ok(());
        }

        write()?;

        match position {
            Some(index) => latest[index].1 = ticket,
            None => latest.push((root.to_path_buf(), ticket)),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn writes_in_order_when_tickets_arrive_in_order() {
        let saves = OrderedSaves::new();
        let written = RefCell::new(Vec::new());
        let root = PathBuf::from("/workspace");

        let first = saves.ticket();
        let second = saves.ticket();
        saves
            .run::<()>(first, &root, || {
                written.borrow_mut().push("first");
                Ok(())
            })
            .unwrap();
        saves
            .run::<()>(second, &root, || {
                written.borrow_mut().push("second");
                Ok(())
            })
            .unwrap();

        assert_eq!(*written.borrow(), vec!["first", "second"]);
    }

    #[test]
    fn skips_an_older_write_that_arrives_after_a_newer_one() {
        let saves = OrderedSaves::new();
        let written = RefCell::new(Vec::new());
        let root = PathBuf::from("/workspace");

        let older = saves.ticket();
        let newer = saves.ticket();
        saves
            .run::<()>(newer, &root, || {
                written.borrow_mut().push("newer");
                Ok(())
            })
            .unwrap();
        saves
            .run::<()>(older, &root, || {
                written.borrow_mut().push("older");
                Ok(())
            })
            .unwrap();

        assert_eq!(*written.borrow(), vec!["newer"]);
    }

    #[test]
    fn tracks_each_root_independently() {
        let saves = OrderedSaves::new();
        let written = RefCell::new(Vec::new());

        let older = saves.ticket();
        let newer = saves.ticket();
        saves
            .run::<()>(newer, Path::new("/a"), || {
                written.borrow_mut().push("a");
                Ok(())
            })
            .unwrap();
        saves
            .run::<()>(older, Path::new("/b"), || {
                written.borrow_mut().push("b");
                Ok(())
            })
            .unwrap();

        assert_eq!(*written.borrow(), vec!["a", "b"]);
    }

    #[test]
    fn a_failed_write_does_not_advance_the_latest_ticket() {
        let saves = OrderedSaves::new();
        let root = PathBuf::from("/workspace");
        let older = saves.ticket();
        let newer = saves.ticket();

        assert_eq!(
            saves.run(newer, &root, || Err("disk full")),
            Err("disk full")
        );

        let mut wrote_older = false;
        saves
            .run::<()>(older, &root, || {
                wrote_older = true;
                Ok(())
            })
            .unwrap();
        assert!(wrote_older);
    }
}
