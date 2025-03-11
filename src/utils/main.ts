// src/utils/main.ts

import ultrasonic from "./ultrasonic";

console.log("Chirp Ultrasonic Service starting...");

// Start the ultrasonic service (i.e., start the receiver)
ultrasonic.start();

// Listen for incoming messages and log them
ultrasonic.on("message", (msg: string) => {
  console.log("Received message:", msg);
});

// After a delay, send a test message over the ultrasonic link
setTimeout(() => {
  console.log("Sending test message...");
  ultrasonic.send("Hello, robust ultrasonic world!");
}, 3000);

// Optionally, stop the service when the page is unloading
window.addEventListener("beforeunload", () => {
  ultrasonic.stop();
});
