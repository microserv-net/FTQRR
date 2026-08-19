# Receiver

Static site. The camera requires a secure context, so serve it over https://
(or localhost) — opening the file directly from disk will not work.

    python3 -m http.server 8000

Press **Turn on the camera** and point it at the sender. Starting mid-transfer
is fine; the sender does not need to know you are there.

Reading the panel:

- **Still missing** is the number that matters. It only goes down.
- **Frames read** — the first number is frames decoded per second, the second
  is frames looked at. A large gap means the camera is struggling: move closer,
  hold steadier, or ask the sender to slow down.
- **Repeats ignored** climbing while progress stalls means the sender is slower
  than your camera. Ask for more frames per second.
- **Held in** shows whether chunks are in memory or written to browser storage.
  Files over 8 MB go to storage so they never occupy the heap all at once.

When it completes, the file is rebuilt and its SHA-256 checked against the
sender's before anything is offered to you. Nothing is written to your device
until you press **Save the file**.
