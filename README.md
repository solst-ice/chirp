# Chirp: Sound-based Data Transfer

This application transmits and receives text and small files through sound: one device plays a short burst of tones through its speaker and another decodes it from its microphone. No network, pairing or account is involved.

## Features

- Send text (any UTF-8, including lowercase and emoji) and small files through sound
- Four modes: **FAST** (~320 bit/s), **ROBUST** (~85 bit/s, for noisy or echoey rooms), **INAUDIBLE** (~65 bit/s, near-ultrasonic 18–19 kHz) and **ENCRYPTED** (~270 bit/s: FAST tones, every frame sealed with a pre-shared key)
- The receiver listens for all of them at once
- Error correction (Reed–Solomon) plus a CRC-32 checksum: text appears as it arrives, and a message only counts as received once it passes its checksum. Frames that are too damaged are reported as corrupted, but a transmission the receiver never detects (too quiet, too far, drowned out) leaves no trace
- Transmission is one-way broadcast: there are no acknowledgments, so the sender cannot tell whether anyone received it. The log marks messages "sent", and its startup line reads "ready · one-way send · auto-receive"
- Cancel any transmission (ESC), resend files to fill gaps, and a loopback TEST that checks whether a device can hear its own signal in the selected mode
- Terminal-style interface: a live 0–20 kHz spectrum with peak hold and a scrolling waterfall, a transfer log with progress bars, per-mode link statistics, and keyboard shortcuts

## How It Works

The modem lives in [`src/modem/`](src/modem/):

1. **Framing**: each message becomes a frame: an 8-symbol preamble, a 10-byte header (mode, type, length, protected by its own Reed–Solomon parity), then the payload + CRC-32 split into Reed–Solomon blocks that are byte-interleaved to spread out burst errors.
2. **Modulation (multi-tone FSK)**: every symbol sounds one tone per group; each group picks one of 16 tones, carrying 4 bits. Even and odd symbols use two interleaved tone sets so room echoes of the previous symbol land on tones the receiver ignores. Short raised-cosine ramps between symbols avoid clicks.
3. **Reception**: an `AudioWorklet` streams raw microphone samples to the demodulators, which use the sample count as their clock rather than timers or screen refreshes. Whether a browser keeps capturing audio in a background tab varies (see Notes). They slide a window looking for the preamble, refine the timing, then read each symbol at its known position while an early/late tracker follows clock drift between devices. Low-confidence bytes are retried as erasures during error correction.
4. **Files**: a manifest frame (name, size, checksum) followed by numbered chunk frames, compressed with deflate when that helps. The manifest is repeated at the end, and **RESEND** reuses the 32-bit file id so a receiver can fill in chunks it missed. Receivers validate manifests against hard limits (256 KB, consistent chunk counts and exact chunk lengths) before allocating anything, cap decompression at the declared size, and keep at most eight incomplete transfers. Chunks that arrive before their manifest are held within the same budgets (no more than the largest valid file per transfer, 1 MB across all of them), and transfers that go quiet for ten minutes are dropped.
5. **Encryption** ([`encryption.ts`](src/modem/encryption.ts)): in ENCRYPTED mode each frame is sealed on its own before modulation, so file chunks can still be opened in any order and RESEND still fills gaps. See Security below.
6. **Transmitting**: one transmission at a time, cancellable, and it waits for any frame currently being received to finish before talking (listen before talk). Transfers longer than 15 minutes of airtime are refused.

The wire format is pinned by known-answer tests (`test/wireFormat.test.ts`); it is not compatible with the earlier character-per-tone version of Chirp, so both devices need this version.

| Mode | Tones | Band | Raw rate | 100-byte message |
|---|---|---|---|---|
| FAST | 4 at a time | 1.5–7.9 kHz | 533 bit/s | ~2.5 s |
| ROBUST | 2 at a time | 1.5–4.7 kHz | 133 bit/s | ~9 s |
| INAUDIBLE | 1 at a time | 18–19 kHz | 100 bit/s | ~12.5 s |
| ENCRYPTED | as FAST | as FAST | 533 bit/s | ~3 s (34 bytes of overhead per frame) |

INAUDIBLE is near-ultrasonic, not ultrasonic, and device-dependent: a 44.1/48 kHz sample rate does not guarantee that a phone or laptop speaker and microphone actually reproduce 18–19 kHz. Run the loopback TEST on each device first. It uses a single tone at a time because two simultaneous high tones can produce an audible difference tone through a small speaker, it will not work over Bluetooth speakers or headsets, and some young people (and most pets) can still hear it.

### Security

In FAST, ROBUST and INAUDIBLE nothing is encrypted: the checksum proves the data was not damaged in transit, not who sent it, and anyone within earshot can transmit or listen. Received text is displayed as plain text and received files are offered only as downloads (`application/octet-stream`), never opened in the page.

**ENCRYPTED** mode seals every frame with AES-256-GCM under a key derived from a pre-shared passphrase (PBKDF2-SHA256, 600,000 iterations, fixed salt). Each frame's payload is `version | 12-byte random nonce | ciphertext of (real frame type | unix time | data) | 16-byte tag`, 34 bytes more than the data it carries.

- **What it protects:** message text, file contents, and file names and types. Only someone with the same passphrase can read a frame, and a frame that was altered, or sealed with a different key, is refused. Decrypted file frames are assembled apart from plain ones, so an unencrypted frame can never join, rename or complete an encrypted transfer.
- **What it does not hide:** that a transmission happened, when, in which mode, and how long it was. The frame type is encrypted, but lengths and traffic patterns (a run of similar-sized chunks between two manifests) can still show whether it was a message or a file.
- **The passphrase is the whole defence.** Anyone who records a transmission can guess passphrases offline, at leisure, and the fixed salt means each guess works against every recording. **GENERATE** fills in a random 25-character key (125 bits), which makes guessing hopeless; read it out to the other device in person. A typed key should be 5 or more random, unrelated words, never a phrase. Everyone who knows it can read every message and can send messages that look genuine; there is no sender identity beyond "knows the key".
- **Replays:** a receiver refuses frames stamped more than 50 minutes ago or more than 30 minutes ahead by its own clock. Frames are stamped when sealed, just before sending, so this allows the two clocks to disagree by up to 30 minutes even at the end of a 15-minute transfer. Within that window it ignores any frame it has already opened, until the page is reloaded; it cannot recognise a replay of a frame it never heard the first time.
- **No forward secrecy:** if the passphrase leaks later, recordings of earlier transmissions can be decrypted.
- **No silent downgrades:** RESEND of a file that was sent encrypted refuses to go out while an unencrypted mode is selected. Demo replies are never sent in answer to an encrypted message, and go out unencrypted on the carrier the command came in on.
- **Key handling:** the key is masked unless SHOW is pressed, locked while sending, kept in memory only, and dropped (along with the derived key) when the field is cleared or the tab closes. A receiver uses it for any encrypted frame it hears, whichever mode is selected for sending; frames that arrive before the key is entered are not kept, so the sender has to resend them. Encryption needs a secure page (https or localhost).
- The loopback TEST is never encrypted: it checks the audio, not the key.

## Getting Started

### Prerequisites

- Node.js 22.18 or newer (the build works on older versions, but the tests run the TypeScript sources directly)
- npm or yarn


### Installation

#### Clone this repository  

First—assuming you have the GitHub CLI—use this command while in your end directory:

   ```bash
   gh repo clone solst-ice/chirp
   ```

Otherwise use this command while in your end directory:

   ```bash
   git clone https://github.com/solst-ice/chirp.git
   ```

#### Install dependencies

   ```bash
   npm install
   ```

   **or**

   ```bash
   yarn
   ```

### Running the Application

```bash
npm run dev
```
**or**
```bash
yarn dev
```

Then open your browser to the URL shown in the terminal (usually http://localhost:5173).

## Usage

1. Open the page on two devices and allow microphone access. Browsers keep audio paused until you interact with the page, so press [ START AUDIO ] in the status bar if it shows AUDIO PAUSED
2. Pick a mode under TRANSMIT (or press alt+1/2/3); the receiver does not need to match, it listens for all modes
3. Type a message and press Enter or [ SEND ], or use [ FILE ] / alt+f to send a file (up to 256 KB and 15 minutes of airtime; transfers over a minute ask for confirmation). ESC cancels
4. Received messages and files appear in the LOG; click a file name to download it. A file that stops arriving is marked incomplete; [ RESEND ] / alt+r on the sender fills in the missing chunks
5. [ TEST ] / alt+t plays a test frame and checks that the same device decodes it, which tells you whether its speaker and microphone work in that mode
6. The status bar shows whether the microphone is live, with RETRY MIC / LISTEN / STOP as needed (RETRY MIC in a log message works too); without a microphone Chirp can still send
7. The diagnostics under the spectrum show per-mode sync/frame/error counts and the signal margin of the last frame
8. [ ? EXPLAIN THIS ] opens a separate page on how data travels through sound, with playable demos; it replaces the app in the tab, so nothing can be received there until you go back

### Development

```bash
npm test        # modem, transmitter, file-transfer and wire-format tests; acoustic tests run through a simulated
                # room (noise, echo, clock drift, dropouts, speaker band limits, speech and music interference)
npm run bench   # delivery rate and goodput per mode under increasingly hard conditions
npm run lint
```

The deploy workflow runs lint and tests before building. The simulator is not a substitute for real devices: it does not model actual speaker/microphone frequency responses, distortion, or OS audio processing.

## Notes

- Best results are achieved with the devices close together; move to ROBUST if FAST fails in an echoey room or with people talking nearby
- Turn off Bluetooth audio output; keep the volume high but not distorting
- Keep the page in the foreground: mobile browsers may suspend audio in background tabs or when the screen locks
- Browser security may require you to explicitly grant permission to use the microphone

## Technologies Used

- React
- TypeScript
- Vite
- Web Audio API
