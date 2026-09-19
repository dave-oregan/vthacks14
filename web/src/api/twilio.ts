import { config } from "../config.js";

/**
 * Scaffolding for Twilio SMS client.
 * In a real environment, you'd install the twilio npm package:
 * npm install twilio
 * import twilio from "twilio";
 */

export async function sendEmergencySms(message: string): Promise<boolean> {
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFromNumber) {
    console.warn("[TWILIO] Missing Twilio credentials. Simulating SMS send.");
    console.log(`[TWILIO-SIM] To: ${config.twilioToNumber} | Message: ${message}`);
    return true;
  }

  try {
    console.log(`[TWILIO] Sending real SMS to ${config.twilioToNumber}...`);
    // Example using the official twilio package:
    // const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
    // const response = await client.messages.create({
    //   body: message,
    //   from: config.twilioFromNumber,
    //   to: config.twilioToNumber
    // });
    // console.log(`[TWILIO] Message sent. SID: ${response.sid}`);

    // Since we're scaffolding, we'll simulate the HTTP request directly
    // to avoid adding external dependencies if they aren't installed yet.
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`;
    const params = new URLSearchParams();
    params.append("To", config.twilioToNumber);
    params.append("From", config.twilioFromNumber);
    params.append("Body", message);

    const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Twilio API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log(`[TWILIO] Message sent successfully. SID: ${data.sid}`);
    return true;
  } catch (error) {
    console.error("[TWILIO] Failed to send emergency SMS:", error);
    return false;
  }
}
