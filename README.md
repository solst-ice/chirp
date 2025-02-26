# Chirp: Sound-based Data Transfer

This application allows you to transmit and receive data through sound. It uses a simple encoding scheme to convert text into audio frequencies, which can be played through your speakers and picked up by a microphone.

## Features

- Real-time frequency visualization of audio input
- Send messages by converting text to sound
- Receive messages by listening to sound and decoding it back to text
- Distinctive start and end signatures to mark transmissions

## How It Works

1. **Text Encoding**: Each character is mapped to a unique frequency
2. **Transmission**: The app plays a start signature, followed by the encoded text, and ends with an end signature
3. **Reception**: The app listens for frequencies, looks for the start signature, decodes the frequencies back to text, and stops at the end signature
4. **Visualization**: Real-time visualization of the frequency spectrum lets you see the data being transmitted and received

## Getting Started

### Prerequisites

- Node.js (version 14 or higher)
- npm or yarn

### Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   # or
   yarn
   ```

### Running the Application

```bash
npm run dev
# or
yarn dev
```

Then open your browser to the URL shown in the terminal (usually http://localhost:5173).

## Usage

1. Click "Start Listening" to begin capturing audio
2. Type a message in the text box at the bottom
3. Click "Transmit Message" to send the message as sound
4. The message will be played through your speakers and should be picked up by your microphone if it's enabled
5. Received messages will appear in the "Received Messages" section

## Notes

- Best results are achieved in a quiet environment
- You may need to adjust your microphone and speaker settings
- Browser security may require you to explicitly grant permission to use the microphone
- This is a proof of concept with a simplified encoding scheme

## Technologies Used

- React
- TypeScript
- Vite
- Web Audio API
