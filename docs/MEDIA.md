# Video conversion

Lume supports MKV and other video containers readable by the installed FFmpeg build. It checks the actual video stream rather than rejecting extensions. MP4/WebM/HLS/DASH retain native/adaptive delivery where compatible. Browser errors first attempt conversion; confirmed upstream/decode failures still hide the failed source. One healthy alternate keeps the title visible. Busy converters, missing executables, expired sessions and client cancellations do not globally hide a title.

## Installation

Install FFmpeg and ffprobe on the web and worker servers. Both must be on PATH or set `FFMPEG_PATH` and `FFPROBE_PATH` to absolute executable paths. Docker installs the tools in the runtime image. `MEDIA_CONVERSION=false` disables conversion; checks needing it retry without fabricating a source failure. `MEDIA_MAX_PROCESSES` defaults to 2, clamped to 1–8 conversion slots per web process. An HLS session retaining fragments occupies a slot even after its encoder finishes. Verification permits up to four probes per process. Tests generate small local MKV/AVI fixtures and require both tools.

## Playback

The server converts video to H.264 with AAC stereo audio and streams fragmented MP4 as it is produced. Output is limited to 1280 pixels wide, preserves smaller source resolution, uses two encoder threads, paces input and applies response backpressure. It does not store or download the whole movie. Conversion is CPU intensive; size the machine and process cap for expected viewers. HDR tone mapping, DRM integration and embedded subtitle conversion are not included. Files without decodable video cannot be made playable solely by changing their extension.

The player retains the original movie duration and saved position. Seeking outside the current buffer starts conversion at that position. Audio tracks are discovered with ffprobe and selected by their actual stream index; changing one preserves the movie position and play/pause intent. Separate language versions continue to use the existing source-language selector.

Safari uses native HLS when available. Its converted video is served through a signed, same-origin HLS playlist with H.264/AAC fragmented MP4 segments. Segment buffers are bounded to 32 MiB per session, pause the encoder when the viewer stops consuming video, and retain a timed grace window for delayed requests. HTTPS pages use server conversion for HTTP sources to avoid mixed-content blocking. Other browsers retain their supported native or adaptive delivery.

Mobile playback can require a tap before audio/video starts. The Play control remains available, and autoplay refusals or interrupted requests do not mark a working source unavailable. Playback JSON requests have a timeout covering both headers and the response body.

Live TV can use native/adaptive delivery or conversion for FFmpeg-readable HTTP(S) broadcasts such as MPEG-TS. Live conversion starts at the current broadcast, returns `startAt:0` and `duration:null`, and does not support saved-position seeking. A nonzero live `startAt` is rejected by the preparation API. The same encoder capacity, startup, cancellation and session limits apply to live broadcasts; this is not a recording or catch-up service.

## Authorization and lifecycle

`POST /api/playback/prepare` requires a valid viewer/source/URL-bound playback attempt. Only saved, enabled, published movie/episode/channel sources can be used; a client cannot provide an arbitrary URL. Existing playback-signing integrations apply before conversion. Media access uses opaque encrypted session grants, validates current source eligibility and URL identity on each request, and is not publicly cached. Local filesystem protocols are excluded from FFmpeg input. Child processes use argument arrays, never shell interpolation, and upstream stderr/credentials are not exposed.

`GET /api/media/:session/stream.mp4` streams the response; native-HLS sessions use `index.m3u8`, `init.mp4` and signed fragment routes under the same media session. `GET /api/playback/session/:session` reports safe status, and `POST /api/playback/release` stops only the viewer's session. Requests stop when disconnected, and idle sessions expire after two minutes (maximum lifetime eight hours). A long pause may require Retry, preserving the saved position. Sessions live in memory: use one web instance or sticky routing. A server restart requires a fresh playback session.

Reverse proxies must disable response buffering for `/api/media/` and allow long-lived streaming responses. Do not cache this route. Conversion accepts saved HTTP(S) sources on the administrator's configured ports, but cannot fix expired provider access, unreachable servers, corrupted files or DRM without the provider integration. FFmpeg HTTPS inputs explicitly enable certificate verification.

Reference: [FFmpeg fragmented MP4 documentation](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv).
