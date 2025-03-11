const ultrasonic = require('./utils/ultrasonic');

ultrasonic.on('message', (msg) => {
  console.log("Received message:", msg);
});

// Start the service (listening for messages)
ultrasonic.start();

// Send a message
ultrasonic.send("Hello, ultrasonic world!");

// Later, to stop the service:
ultrasonic.stop();
