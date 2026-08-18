//! Process-wide ceiling on **concurrent paid provider calls**, one bucket per
//! provider.
//!
//! [`super::concurrency_for`] is the `buffer_unordered` width inside a single
//! runner, so it bounds one job and nothing more: with
//! [`crate::jobs::MAX_ACTIVE_JOBS`] jobs admitted, four proofread jobs against
//! OpenAI could keep 4 × 5 = 20 chat completions in flight and immediately
//! refill each slot as it drained. The job cap answers "how many *jobs* run at
//! once"; this answers "how many *requests* are on the wire at once", and the
//! two are not the same question — the second one is the one that shows up on
//! the bill and in the provider's rate limiter.
//!
//! Permits are held across the provider call itself, including Paddle's whole
//! poll loop (one submitted Paddle job occupies one slot at Paddle's end, which
//! is precisely what we mean to bound). Acquisition races the job's
//! `CancellationToken`, so a cancel while queued for a slot returns
//! immediately instead of waiting for a slot it no longer wants.

use std::sync::OnceLock;

use tokio::sync::{Semaphore, SemaphorePermit};
use tokio_util::sync::CancellationToken;

use super::concurrency_for;
use crate::config::Provider;
use crate::error::{AppError, AppResult};

/// One semaphore per provider. Separate buckets because the limits describe
/// different things — a self-hosted vLLM box saturating at 2 says nothing about
/// how many calls OpenAI will take — and because a shared bucket would let a
/// slow provider throttle a fast one.
struct ProviderGates {
    paddle: Semaphore,
    openai: Semaphore,
    openrouter: Semaphore,
    compatible: Semaphore,
}

impl ProviderGates {
    fn new() -> Self {
        Self {
            paddle: Semaphore::new(concurrency_for(Provider::Paddleocr)),
            openai: Semaphore::new(concurrency_for(Provider::Openai)),
            openrouter: Semaphore::new(concurrency_for(Provider::Openrouter)),
            compatible: Semaphore::new(concurrency_for(Provider::OpenaiCompatible)),
        }
    }

    fn for_provider(&self, provider: Provider) -> &Semaphore {
        match provider {
            Provider::Paddleocr => &self.paddle,
            Provider::Openai => &self.openai,
            Provider::Openrouter => &self.openrouter,
            Provider::OpenaiCompatible => &self.compatible,
        }
    }
}

fn gates() -> &'static ProviderGates {
    static GATES: OnceLock<ProviderGates> = OnceLock::new();
    GATES.get_or_init(ProviderGates::new)
}

/// Waits for a slot on `provider`'s bucket. Hold the returned permit for the
/// duration of the request; dropping it frees the slot.
pub async fn acquire(
    provider: Provider,
    cancel: &CancellationToken,
) -> AppResult<SemaphorePermit<'static>> {
    acquire_from(gates(), provider, cancel).await
}

/// [`acquire`] against an explicit set of gates. Split out so the queueing
/// behaviour can be tested on a local instance — saturating the process-wide
/// gates inside a test would starve every other test sharing the binary.
async fn acquire_from<'a>(
    gates: &'a ProviderGates,
    provider: Provider,
    cancel: &CancellationToken,
) -> AppResult<SemaphorePermit<'a>> {
    tokio::select! {
        permit = gates.for_provider(provider).acquire() => {
            permit.map_err(|_| AppError::Internal("provider gate closed".into()))
        }
        _ = cancel.cancelled() => Err(AppError::Cancelled(
            crate::tr!("等待调用配额时取消", "cancelled while waiting for a provider slot").into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn never_cancelled() -> CancellationToken {
        CancellationToken::new()
    }

    #[test]
    fn each_bucket_starts_at_its_provider_concurrency() {
        let gates = ProviderGates::new();
        for provider in [
            Provider::Paddleocr,
            Provider::Openai,
            Provider::Openrouter,
            Provider::OpenaiCompatible,
        ] {
            assert_eq!(
                gates.for_provider(provider).available_permits(),
                concurrency_for(provider),
                "{provider:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_saturated_bucket_makes_the_next_call_wait_then_admits_it() {
        let gates = ProviderGates::new();
        let cancel = never_cancelled();
        let limit = concurrency_for(Provider::Openai);
        let mut held = Vec::new();
        for _ in 0..limit {
            held.push(
                acquire_from(&gates, Provider::Openai, &cancel)
                    .await
                    .unwrap(),
            );
        }

        let queued = tokio::time::timeout(
            Duration::from_millis(50),
            acquire_from(&gates, Provider::Openai, &cancel),
        )
        .await;
        assert!(queued.is_err(), "the {limit}th+1 call must queue");

        // A different provider's bucket is untouched by OpenAI saturation.
        let _elsewhere = acquire_from(&gates, Provider::Openrouter, &cancel)
            .await
            .unwrap();

        held.pop();
        let _freed = acquire_from(&gates, Provider::Openai, &cancel)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancelling_while_queued_returns_cancelled() {
        let gates = ProviderGates::new();
        let cancel = never_cancelled();
        let mut held = Vec::new();
        for _ in 0..concurrency_for(Provider::OpenaiCompatible) {
            held.push(
                acquire_from(&gates, Provider::OpenaiCompatible, &cancel)
                    .await
                    .unwrap(),
            );
        }

        let queued_cancel = CancellationToken::new();
        let waiter = queued_cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            waiter.cancel();
        });
        let err = acquire_from(&gates, Provider::OpenaiCompatible, &queued_cancel)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled(_)), "{err:?}");
    }
}
