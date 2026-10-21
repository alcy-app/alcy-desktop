//! Execution-scoped human input queues. Values never travel back through IPC.

use std::collections::HashMap;
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};

use alcy_app::{FlowHumanInteraction, FlowRunSink, FormAnswers, FormOptionPage, PreparedFlowForm};
use serde::Deserialize;
use tokio::sync::oneshot;

use super::flow_execution_registry::FlowExecutionRegistry;

struct PendingForm {
    execution_id: String,
    node_id: String,
    prepared: PreparedFlowForm,
    sender: oneshot::Sender<FormAnswers>,
}

#[derive(Default)]
pub struct HumanFormRegistry {
    pending: Mutex<HashMap<String, PendingForm>>,
    sequence: AtomicU64,
}

pub struct HumanFormSession<'a, S> {
    pub registry: &'a HumanFormRegistry,
    pub execution_id: &'a str,
    pub sink: &'a S,
}

struct PendingGuard<'a> {
    registry: &'a HumanFormRegistry,
    wait_id: String,
}

impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.registry
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.wait_id);
    }
}

impl<S: FlowRunSink> FlowHumanInteraction for HumanFormSession<'_, S> {
    async fn request_input(
        &self,
        node_id: &str,
        prepared: PreparedFlowForm,
    ) -> Result<FormAnswers, String> {
        let wait_id = format!(
            "{}:{}",
            self.execution_id,
            self.registry.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = oneshot::channel();
        self.registry
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                wait_id.clone(),
                PendingForm {
                    execution_id: self.execution_id.into(),
                    node_id: node_id.into(),
                    prepared,
                    sender,
                },
            );
        let _guard = PendingGuard {
            registry: self.registry,
            wait_id: wait_id.clone(),
        };
        self.sink.node_waiting_for_human(node_id, &wait_id);
        let answers = receiver
            .await
            .map_err(|_| "Human interaction ended".to_string())?;
        self.sink.node_form_submitted(node_id);
        Ok(answers)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowFormRequest {
    pub flow_execution_id: String,
    pub node_id: String,
    pub wait_id: String,
}

impl HumanFormRegistry {
    async fn submit(&self, input: FlowFormRequest, answers: FormAnswers) -> Result<(), String> {
        let prepared = self.prepared(&input)?;
        let values =
            tauri::async_runtime::spawn_blocking(move || prepared.validate_answers(&answers))
                .await
                .map_err(|_| "unavailable".to_string())??;
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        // Validation can race cancellation or another submission; only one sender wins.
        let form = pending.remove(&input.wait_id).ok_or("staleInteraction")?;
        form.sender
            .send(values)
            .map_err(|_| "staleInteraction".into())
    }
    pub fn cancel_execution(&self, execution_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, form| form.execution_id != execution_id);
    }
    fn prepared(&self, request: &FlowFormRequest) -> Result<PreparedFlowForm, String> {
        let pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let form = pending
            .get(&request.wait_id)
            .filter(|form| {
                form.execution_id == request.flow_execution_id && form.node_id == request.node_id
            })
            .ok_or("staleInteraction")?;
        Ok(form.prepared.clone())
    }
}

#[tauri::command]
pub async fn submit_flow_form(
    input: FlowFormRequest,
    answers: FormAnswers,
    registry: tauri::State<'_, FlowExecutionRegistry>,
) -> Result<(), String> {
    registry.human.submit(input, answers).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    struct Sink;
    impl FlowRunSink for Sink {
        fn node_started(&self, _: &str) {}
        fn node_finished(&self, _: &str, _: alcy_app::FlowNodeOutcome) {}
    }

    fn form() -> PreparedFlowForm {
        PreparedFlowForm {
            form: Default::default(),
            sources: HashMap::new(),
        }
    }
    fn input(wait_id: &str) -> FlowFormRequest {
        FlowFormRequest {
            flow_execution_id: "run".into(),
            node_id: "human".into(),
            wait_id: wait_id.into(),
        }
    }

    #[tokio::test]
    async fn submission_is_scoped_single_use_and_new_iterations_get_new_wait_ids() {
        let registry = HumanFormRegistry::default();
        let session = HumanFormSession {
            registry: &registry,
            execution_id: "run",
            sink: &Sink,
        };
        let mut previous = String::new();
        for _ in 0..2 {
            let mut waiting = Box::pin(session.request_input("human", form()));
            poll_fn(|cx| {
                assert!(waiting.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            let wait_id = registry
                .pending
                .lock()
                .unwrap()
                .keys()
                .next()
                .unwrap()
                .clone();
            assert_ne!(wait_id, previous);
            let mut wrong = input(&wait_id);
            wrong.flow_execution_id = "other".into();
            assert!(registry.submit(wrong, FormAnswers::new()).await.is_err());
            registry
                .submit(input(&wait_id), FormAnswers::new())
                .await
                .unwrap();
            assert!(
                registry
                    .submit(input(&wait_id), FormAnswers::new())
                    .await
                    .is_err()
            );
            assert!(waiting.await.unwrap().is_empty());
            previous = wait_id;
        }
    }

    #[tokio::test]
    async fn dropping_a_wait_or_cancelling_an_execution_removes_pending_forms() {
        let registry = HumanFormRegistry::default();
        let session = HumanFormSession {
            registry: &registry,
            execution_id: "run",
            sink: &Sink,
        };
        let mut waiting = Box::pin(session.request_input("human", form()));
        poll_fn(|cx| {
            assert!(waiting.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        let wait_id = registry
            .pending
            .lock()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        drop(waiting);
        assert!(registry.prepared(&input(&wait_id)).is_err());
        let mut waiting = Box::pin(session.request_input("human", form()));
        poll_fn(|cx| {
            assert!(waiting.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        registry.cancel_execution("run");
        assert!(waiting.await.is_err());
        assert!(registry.pending.lock().unwrap().is_empty());
    }
}

#[tauri::command]
pub async fn list_flow_form_options(
    input: FlowFormRequest,
    field_id: String,
    offset: usize,
    registry: tauri::State<'_, FlowExecutionRegistry>,
) -> Result<FormOptionPage, String> {
    let prepared = registry.human.prepared(&input)?;
    tauri::async_runtime::spawn_blocking(move || prepared.option_page(&field_id, offset))
        .await
        .map_err(|_| "unavailable".to_string())?
}
