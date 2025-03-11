// src/utils/main.ts
import ultrasonic from "./ultrasonic";
import { Buffer } from 'buffer';
(window as any).Buffer = Buffer;

console.log("Starting Ultrasonic Service...");

// Start the ultrasonic service (which starts the receiver)
ultrasonic.start();

// Listen for incoming messages and log them
ultrasonic.on("message", (message: string) => {
  console.log("Received message:", message);
});

// Send a test message after 3 seconds
setTimeout(() => {
  console.log("Sending test message...");
  ultrasonic.send("Hello, robust ultrasonic world!");
}, 3000);

// Optional: Stop the ultrasonic service when the window is about to unload
window.addEventListener("beforeunload", () => {
  ultrasonic.stop();
});
