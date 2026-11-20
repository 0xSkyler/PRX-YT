# Native playback fixture

`playback.webm` is a locally generated 7.008-second video with VP8 picture,
160 × 90 dimensions, 12 frames/second and a silent Opus audio track. It is test
data and is excluded from packaged applications by the existing file allowlist.

Reproduce it with FFmpeg:

```sh
ffmpeg -f lavfi -i 'testsrc2=size=160x90:rate=12' \
  -f lavfi -i 'anullsrc=channel_layout=mono:sample_rate=48000' \
  -t 7 -c:v libvpx -b:v 80k -deadline realtime -cpu-used 8 \
  -c:a libopus -b:a 16k -shortest playback.webm
```

`scripts/smoke-youtube-playback.cjs` launches the real source or packaged app,
serves this file through test-only HTTPS protocol handlers registered on each
isolated Electron session, and observes actual HTML5 video advancement and
ending. It exercises the unmodified production playback controller and IPC.
There are no public YouTube requests and no command-line autoplay-policy override.
An unfinished image response keeps document loading open while the real media
advances, checking that playback inspection does not wait for full-page load.

A separate controlled page makes `video.play()` reject with `NotAllowedError`
to verify blocked-playback reporting and absence of automatic retry loops.
The real-media path uses Chromium's actual `HTMLMediaElement.play()`.

The local proxy feed supplies unique loopback endpoints. Assertions check
Electron's native proxy-routing configuration and provider retention/reuse.
Protocol interception bypasses external transport, so these fixtures do not
establish that real public proxies can carry YouTube streams.
