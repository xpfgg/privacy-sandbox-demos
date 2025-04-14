/*
 Copyright 2022 Google LLC
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
      https://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

import cbor from 'cbor';

// Decodes Base64 CBOR Aggregation Service Payload
export async function decodePayload(
  payload: string,
): Promise<{bucket: bigint; value: number}[]> {
  try {
    const arr = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const decoded: any = await cbor.decodeFirst(arr);

    if (!decoded?.data || !Array.isArray(decoded.data)) {
      // Simplified check
      throw new Error("Decoded data missing 'data' array");
    }

    const contributions = decoded.data
      .map((item: any): {bucket: bigint; value: number} | null => {
        if (!item?.bucket || typeof item.value === 'undefined') {
          // Check existence and type if needed
          // console.warn("Skipping invalid item:", item); // Optional log
          return null;
        }
        try {
          // Assumes Buffer-like objects with toString('hex') and readUInt32BE
          const bucketBigInt = BigInt(`0x${item.bucket.toString('hex')}`);
          const valueNumber = item.value.readUInt32BE(0);
          return {bucket: bucketBigInt, value: valueNumber};
        } catch (mapError: any) {
          console.error('Error processing CBOR item:', mapError.message, item); // Log specific error
          return null;
        }
      })
      .filter(
        (item: any): item is {bucket: bigint; value: number} => item !== null,
      ); // Filter nulls, type predicate still works with inline type

    return contributions;
  } catch (error: any) {
    console.error(`Error decoding payload: ${error.message}`);
    // Avoid logging full payload in error? console.error("Input payload:", payload);
    throw error; // Re-throw
  }
}
