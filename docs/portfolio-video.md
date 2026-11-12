# Blackbox portfolio walkthrough

**[Play or download MP4](images/blackbox-demo.mp4)** · [WebM](images/blackbox-demo.webm)

1920 × 1080, 25 fps, approximately 74 seconds. MP4 uses H.264, YUV 4:2:0 and a fast-start header. English captions are part of the picture, so the story works without audio. There is no soundtrack or voice-over.

## Story

| Approximate time | What the viewer sees |
| --- | --- |
| 0:00 | The problem: a successful write whose response never arrives |
| 0:06 | A real fault scenario and unprotected demo client |
| 0:14 | Two database writes from one logical action |
| 0:23 | Request inspection: upstream 201, no client response |
| 0:33 | The same failure with a deduplicating API and an idempotent client |
| 0:45 | Saved results compared; configuration and result exported |
| 0:59 | The actual responsive console at a mobile width |
| 1:08 | Closing frame and repository address |

The application is captured live, with real HTTP requests and a fresh SQLite database. The recording script asserts that the unprotected run stored two workouts, the idempotent run stored one, and the exported result matches the successful run. [The actual records](evidence/interface-redesign/recorded-experiments.json) are retained.

The HTML recording stage adds chapter labels, captions, title cards and a cursor highlight around the live application. It does not replace API responses or application results. For framing only, the recording browser removes the local UI response's frame restriction; the shipped server's content security policy is unchanged. The capture is a guided demo, not an unedited user session.

## Reproduce

Build Blackbox first. Install the frontend development dependencies and Chrome. Install Playwright's recording encoder from `web/`:

```powershell
cd web
npx playwright install ffmpeg
cd ..
node scripts/record-portfolio.mjs
```

The script uses isolated ports `22990–22992` and a new database under `.blackbox/portfolio-*`. It starts and stops its own server and browser. It writes the WebM to `docs/images/blackbox-demo.webm`; an optional first argument chooses another output path. Screenshots, chapter timings, exported JSON and server logs stay in the recording directory.

For a short production rehearsal, set `BLACKBOX_VIDEO_DRY_RUN=1`. Remove it before the final capture. `BLACKBOX_BROWSER_CHANNEL` can select another installed Playwright channel; `PLAYWRIGHT_BROWSERS_PATH` can select an existing encoder installation.

Convert the WebM with a full FFmpeg installation:

```sh
ffmpeg -y -ss 0.4 -i docs/images/blackbox-demo.webm -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -movflags +faststart -an docs/images/blackbox-demo.mp4
ffmpeg -y -ss 17 -i docs/images/blackbox-demo.mp4 -frames:v 1 docs/images/blackbox-video-poster.png
```

The small initial trim removes capture startup. There are no speed changes or substituted results. The poster is a frame extracted from the final MP4.

## Verification

The exported MP4 was decoded from start to finish with FFmpeg, loaded in Chrome, and sought to 2, 17, 27, 41, 51, 63 and 72 seconds. Representative decoded frames and the recording's chapter screenshots were visually inspected. The video has no application JavaScript errors in the recorded session. [Media metadata and checksums](evidence/interface-redesign/media-check.json).

To use it in a portfolio, upload the MP4 alongside the project and use the poster as its thumbnail. The README links both formats; GitHub's Markdown does not reliably render arbitrary inline video tags.
