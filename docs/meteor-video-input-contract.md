# Meteor Canvas media input contract (2026-10-28)

This contract adds validation only; it does not change gateway prices, billing,
asset review, result finalization or seven-day retention.

## Public capabilities

GET media capabilities returns existing price scenarios plus:

- uploads: imageMaxBytes=20971520, videoMaxBytes=52428800,
  audioMaxBytes=20971520, totalReferenceMaxBytes=104857600,
  policySource=site, metadataRequired=true. These are site protection budgets,
  not claims about upstream byte limits.
- videoInput: modes, referenceTypes, firstFrame, lastFrame,
  lastFrameRequiresFirst, framesWithReferences, audioOnlyReferences,
  referenceVideoWithGeneratedAudio, referenceDuration, referenceLimits and
  validationNotice. referenceLimits counts images/videos/audios/total after
  intersecting documented type counts with the site's total four-material cap.
- image resolutions: non-null 1K/2K/4K keys from actual imagePriceBySize. Known
  gpt-image-2 family models with an available token tariff also expose 1K/2K/4K
  as model size capabilities; this does not imply per-image fixed pricing or
  a known total. Unknown token models without confirmed resolution information
  return an empty list. Quality is independent of resolution. Existing gateway
  size/price tier calculation remains unchanged.

| Model | Reference images/videos/audios | Audio only | Reference duration | Frames |
| --- | --- | --- | --- | --- |
| Seedance 2.5 | 4/4/4, total 4 | yes | each 2–30 s | first, first+last |
| Seedance 2.0/Fast/Mini | 4/3/3, total 4 | no | each 2–15 s | first, first+last |
| Seedance 1.5 Pro | no reference mode | no | n/a | first, first+last |
| Kling v3 | no reference mode | no | n/a | first, tail, first+tail |
| Kling v3 Omni | 4/4/0, total 4 | no | not asserted | first, tail, first+tail |

All support text mode. Seedance 2.5 first-frame mode requires adaptive ratio.
Omni reference video plus generated audio is rejected, as documented.
Frames and generic reference inputs are separate *site compatibility modes*.
The current provider document did not contain an explicit universal prohibition
on mixing those roles; the site deliberately rejects it rather than dropping
selected materials. Fixed integer generation durations only; auto duration -1,
draft, edit and extend are not exposed by this billing-compatible adapter.

Model resolutions and durations intersect actual currently-priced scenarios:

- Seedance 1.5 Pro: 480p/720p/1080p; 4–12 s.
- Seedance 2.5: 480p/720p/1080p; 4–30 s.
- Seedance 2.0: 480p/720p/1080p/4K; 4–15 s.
- Seedance 2.0 Fast/Mini: 480p/720p; 4–15 s.
- Kling v3/Omni: 720p/1080p/4K; 3–15 s (and actual priced scenarios).
- Native Grok preserves its existing conservative adapter/scenarios.

## Upload and submission boundary

Multipart uploads stream to a unique 0600 temporary file in the persistent
media data directory. No full-file upload buffer is created. MIME signatures,
actual dimensions and media duration are checked before atomic storage and
quota registration. Uploads and probes each have a separate concurrency cap of
two. ffprobe receives only a local file, fixed arguments, file/pipe protocol
whitelist, one codec thread, 12-second deadline and 64 KiB output budget. The
runtime image installs the official Debian ffmpeg package during GitHub build.

Additional site parser budgets: maximum dimension 8192, 40 million image/video
pixels, and 300-second uploaded audio/video duration. Model-specific reference
duration limits are stricter where documented. Failed temporary files are
removed by their single known path. Existing result storage keeps its separate
64 MiB budget; video result caching is not reduced to upload limits.

Upload response adds width, height and durationSeconds to existing IDs/URLs.
Server-derived metadata is authoritative; browser metadata is advisory.

Before a durable paid-task receipt is claimed:

1. Canonicalize aliases and reject malformed references or ambiguous frames.
2. Validate model role combinations, counts, duration, ratio and live price
   scenario. Reject unsupported rich protocol/draft modes instead of silently
   discarding them.
3. Reuse only the current user's unexpired verified local objects. Re-probe
   legacy objects without verified metadata.
4. HTTP(S) inputs use DNS-pinned public-only fetching, bounded streaming import,
   and the same file validation/quota checks. data URLs use a streaming base64
   decoder. Unverified provider asset IDs are rejected.
5. Check actual MIME/category, per-material duration and aggregate 100 MiB.
6. Send fresh canonical site-signed URLs using METEOR_PUBLIC_BASE, defaulting
   to https://api.meteor21c.fun. The main gateway still owns its normal asset
   review and charging.

Existing task IDs return durable existing status and never replay generation.
A deliberate new historical generation request uses this same validated path.
Retention remains seven days, owner quota 512 MiB / 256 files, site quota 2 GiB.

## Official source evidence

The current public SPA document source was inspected on 2026-10-28:

- https://admin-aigc.fzyinghe.com/async/doc?model=doubao-seedance-2.0#series-seedance-2-0
- https://admin-aigc.fzyinghe.com/assets/SeedanceSeries-DcIGw3pQ.js
- https://admin-aigc.fzyinghe.com/assets/KlingSeries-D5zkVMdJ.js
- https://admin-aigc.fzyinghe.com/assets/TencentVegaMaterialDocs-CUcni_br.js

V3 common docs say public HTTP(S) or owned asset IDs, not Base64. Canvas data
URLs are therefore imported as verified local files before forwarding. No MB
byte limits were found in these current official sections; site budgets above
are explicitly local policy. Prompt lengths in those documents are
recommendations and are not misrepresented as hard rejection limits.
