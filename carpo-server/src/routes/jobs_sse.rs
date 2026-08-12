use axum::{
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
};
use futures::StreamExt;
use tokio_stream::wrappers::BroadcastStream;

use crate::app_state::ServerState;

pub async fn events(
    State(state): State<ServerState>,
) -> Sse<impl futures::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let stream = BroadcastStream::new(state.core.events.subscribe()).filter_map(|event| async {
        match event {
            Ok(event) => Some(Ok(Event::default()
                .event(event.kind.as_sse_name())
                .data(event.payload.to_string()))),
            Err(err) => {
                tracing::warn!("job event stream lagged: {err}");
                None
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}
