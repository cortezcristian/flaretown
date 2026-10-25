# Container images

Every agent can have one container (its "sandbox", SPEC-sandbox and SPEC-containers 0). This folder holds the images built by us and by you.

| Image | Where | Default instance |
|---|---|---|
| `debian` | Stock `cloudflare/debian-trixie` (Node, npm). Not built here | `lite` |
| `desktop` | `desktop/`: minimal XFCE, Chromium, noVNC, agent-browser, `less`/`vim`/`tmux`, `pbcopy`/`pbpaste` | `standard-1` |

## Add your own image

1. Create `containers/<name>/` with a `Dockerfile` and a `.dockerignore` that ignores everything and allows only what the Dockerfile copies (`*` then `!file`). Without it the whole repo goes into the build context.
2. Easiest start: `FROM` an existing image and add on top.
3. Image contract (checked by `pnpm check:images`):
   - `linux/amd64`
   - `bash` and coreutils `timeout` (agents run commands with `timeout ... bash -lc`)
   - the entrypoint keeps running (or use `sleep infinity`)
   - size well under the instance disk (`lite` 2 GB, `basic` 4 GB, `standard-1` 8 GB): keep at least half free
4. Add it to `images` in **each** of the three `containers` entries in `wrangler.jsonc` (Principal, Lead, Operator): `"<name>": { "dockerfile": "./containers/<name>/Dockerfile" }`.
5. Optional: the first line of `containers/<name>/README.md` is shown to the agent as the image description.
6. `pnpm run deploy` (Wrangler builds and pushes the image; Docker must be running). It then shows up in the Container select.
