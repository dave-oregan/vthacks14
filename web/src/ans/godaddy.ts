import { config } from "../config.js";

interface CacheEntry {
  verified: boolean;
  timestampMs: number;
}

// In-memory cache for ANS identities
// Key: ansName (e.g., "ans://v1.0.0.observer.sightline.local")
// Value: CacheEntry
const identityCache = new Map<string, CacheEntry>();

// Cache TTL: 24 hours (we don't want to expire during a live emergency)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Verifies an agent's identity using the GoDaddy ANS API.
 * Uses a local cache to prevent redundant API calls, especially during emergencies.
 * 
 * @param ansName The full ANS URI (e.g., ans://v1.0.0.observer.sightline.local)
 * @returns boolean indicating if the identity is verified
 */
export async function verifyAnsIdentity(ansName: string): Promise<boolean> {
  const now = Date.now();
  const cached = identityCache.get(ansName);

  if (cached && now - cached.timestampMs < CACHE_TTL_MS) {
    console.log(`[ANS] Cache hit for ${ansName}: ${cached.verified ? "VERIFIED" : "BLOCKED"}`);
    return cached.verified;
  }

  console.log(`[ANS] Cache miss for ${ansName}. Verifying with GoDaddy ANS...`);

  // Extract the domain part from the ans:// URI if possible
  // Expected format: ans://<version>.<name>.<domain>
  const match = ansName.match(/^ans:\/\/([^/]+)$/);
  const domainPart = match ? match[1] : ansName;

  try {
    // Scaffolded GoDaddy API Call
    // In a real implementation, this would hit the GoDaddy ANS API endpoints
    // or perform a DNS TXT record lookup.
    
    if (!config.godaddyApiKey) {
      console.warn(`[ANS] GoDaddy API keys missing. Simulating verification for ${ansName}.`);
      // Simulate verification: Allow our team domain by default
      const isVerified = domainPart.endsWith(config.ansTeamDomain);
      
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 500));
      
      identityCache.set(ansName, { verified: isVerified, timestampMs: now });
      return isVerified;
    }

    const apiUrl = `https://api.godaddy.com/v1/domains/${domainPart}/records/TXT`; // Example endpoint
    
    // Simulate real fetch (replace with real fetch when API is known)
    const authHeader = config.godaddyApiSecret 
      ? `sso-key ${config.godaddyApiKey}:${config.godaddyApiSecret}`
      : `Bearer ${config.godaddyApiKey}`; // Support PATs

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Authorization": authHeader,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      if (response.status === 404 || response.status === 422) {
        console.warn(`[ANS] Domain ${domainPart} not found or invalid (status ${response.status}). Defaulting to domain string match for hackathon.`);
        const isFallbackVerified = domainPart.endsWith(config.ansTeamDomain);
        identityCache.set(ansName, { verified: isFallbackVerified, timestampMs: now });
        return isFallbackVerified;
      }
      throw new Error(`GoDaddy API returned ${response.status}`);
    }
    
    const data = await response.json();
    const isVerified = data.some((record: any) => record.name === "ans-verification");
    
    identityCache.set(ansName, { verified: isVerified, timestampMs: now });
    return isVerified;
  } catch (error) {
    console.error(`[ANS] Error verifying identity for ${ansName}:`, error);
    // On error, do not cache a negative result if we suspect it's a network issue,
    // but for security we must return false.
    return false;
  }
}
