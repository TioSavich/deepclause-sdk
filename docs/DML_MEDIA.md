# Images and video in DML

How DeepClause handles media (images now; video later), and the decisions behind
the implementation. Status: **image input implemented**; image generation and
video are planned.

## Principles

* **Media are workspace files.** DML carries a *reference*, never the bytes.
  Base64 in clauses would blow up the "small, inspectable" module model and break
  export/history. This is the `script_file/2` convention applied to media.
* **Reference-only memory.** Conversation memory may hold media, but only as
  `media(Path, MimeType)`. Bytes are resolved from the workspace at call time.
* **No vision in judgments.** `choose`/`rate`/`verify`/`probability` stay text
  only.
* **Reuse pi's models and credentials.** Vision input and image generation run on
  the active pi backend; no separate keys.

## Representation

```prolog
media(Path, MimeType).          % workspace-relative path + mime; the reference
```

`read_media(+Path, -Media)` derives the mime from the extension (PNG/JPEG/GIF/
WebP) and fails for other types. `attach_media(+Media)` appends a user memory
message carrying `media: [media(Path, Mime)]`; the model then sees the image.

Host side:

```ts
interface MediaRef { path: string; mimeType: string; }
interface LLMBackendMedia { mimeType: string; data: string; }   // base64, resolved
```

`MemoryMessage.media?: MediaRef[]` (reference-only) and
`LLMBackendMessage.media?: LLMBackendMedia[]` (bytes for the call).

## Images in (vision)

`task/N` runs an agent loop over the conversation memory. Media references in
memory are resolved to base64 (mime allowlist, size cap) and attached as pi
`ImageContent` blocks on the corresponding user message. A text-only model
receives the text and a `[attached ...]` note, not the image block, when
`media.blockImages` is set.

## Images out (generation)

`gen_image(Prompt, Out, Refs..., Result)` is a host capability tool:
resolve an image model from the pi registry (`getModelOfType("image", ...)`),
call `generateImages(model, { input })`, write the base64 block to
`media.dir`, and return `media(Out, Mime)`. Generated images can be fed back to a
vision task.

## Rendering

Generated media is reported on a `media` event carrying the path (and optional
inline data). The plain renderer prints the workspace path; inline terminal
rendering (kitty/iTerm2) is deferred.

## Video (deferred)

pi has no video content type. The pattern is: sample frames with `ffmpeg` (via
`bash`), treat each frame as an image, optionally transcribe audio, and assemble
output with `ffmpeg`. No core video type.

## Guardrails

* Workspace path isolation (same resolver as scripts).
* MIME allowlist (PNG/JPEG/GIF/WebP) and a byte-size cap; no remote URLs.
* Media is recorded by `(path, mime)` only; never bytes, in facts/history.
* Text-only fallback fails clearly rather than silently dropping the image.

## Config (planned)

The MVP uses constants (PNG/JPEG/GIF/WebP allowlist, 10 MiB cap in
`src/system/runtime/media.ts`). A `media` config section is planned:

```json
"media": { "dir": ".deepclause/media", "maxBytes": 10485760, "blockImages": false }
```
