const USE_CASE_ID_BITS = 8;
const MAX_TOTAL_BITS = 128; // Maximum key size allowed by APIs
//
// // Use Case IDs Registry (Add more as needed)
const USE_CASES = {
  // Private Aggregation Examples
  BID_DENSITY: 1,
  BID_REJECTION: 2,
  BID_DENSITY_ADVANCED: 3,
  UNIQUE_REACH: 25,
  // Attribution Reporting Examples (could also be used by PA)
  CONVERSION_COUNT: 10,
  CONVERSION_VALUE: 11,
};

/**
 * Configuration object defining the structure for each use case.
 * Keys are Use Case IDs from USE_CASES.
 */
const AGGREGATION_KEY_CONFIG = {
  [USE_CASES.BID_DENSITY]: {
    description: 'Basic Bid Density: CPM Bin, Buyer, Publisher',
    dimensions: [
      // Dimensions ordered by offset (right-to-left in the key)
      {
        name: 'cpmValue', // Input dimension name from dataDict
        outputName: 'cpmBinId', // Optional: for clarity if processed
        bits: 5,
        offset: 8, // Starts right after the 8 use case bits
        processor: {type: 'bin', params: {binSize: 0.5, maxThreshold: 10.0}},
      },
      {
        name: 'buyerId',
        outputName: 'buyerMappedId',
        bits: 3,
        offset: 13, // Starts after cpmBinId (8 + 5)
        processor: {
          type: 'map',
          params: {
            mapping: {'dsp-a': 1, 'dsp-b': 2, 'dsp': 3},
            defaultValue: 0,
          },
        },
      },
      {
        name: 'publisherId', // Assuming this is already an integer index
        outputName: 'publisherId',
        bits: 4,
        offset: 16, // Starts after buyerId (13 + 3)
        processor: {type: 'direct'}, // Explicitly state direct processing
      },
    ],
  },

  [USE_CASES.BID_REJECTION]: {
    description: 'Bid Rejection: CPM Bin, Seller, Reason',
    dimensions: [
      {
        name: 'cpmValue',
        outputName: 'cpmBinId',
        bits: 5,
        offset: 8,
        processor: {type: 'bin', params: {binSize: 0.5, maxThreshold: 10.0}},
      },
      {
        name: 'sellerId',
        outputName: 'sellerId',
        bits: 3,
        offset: 13,
        processor: {type: 'direct'},
      },
      {
        name: 'rejectionReasonId',
        outputName: 'rejectionReasonId',
        bits: 4,
        offset: 16,
        processor: {type: 'direct'},
      },
    ],
  },

  [USE_CASES.BID_DENSITY_ADVANCED]: {
    description: 'Advanced Bid Density (Multi-dimensional)',
    dimensions: [
      // Right-most dimension first (lowest offset)
      {
        name: 'geoId',
        outputName: 'geoId',
        bits: 6,
        offset: 8,
        processor: {type: 'direct'},
      },
      {
        name: 'deviceId',
        outputName: 'deviceId',
        bits: 3,
        offset: 14,
        processor: {type: 'direct'},
      },
      {
        name: 'slotId',
        outputName: 'slotId',
        bits: 5,
        offset: 17,
        processor: {type: 'direct'},
      },
      {
        name: 'categoryId',
        outputName: 'categoryId',
        bits: 8,
        offset: 22,
        processor: {type: 'direct'},
      },
      {
        name: 'buyerId',
        outputName: 'buyerId',
        bits: 10,
        offset: 30,
        processor: {type: 'direct'},
      }, // Assumes integer ID here
      {
        name: 'publisherId',
        outputName: 'publisherId',
        bits: 12,
        offset: 40,
        processor: {type: 'direct'},
      },
    ],
  },

  [USE_CASES.CONVERSION_COUNT]: {
    description: 'Conversion Count (Campaign, Geo, Product Cat)',
    dimensions: [
      {
        name: 'geoId',
        outputName: 'geoId',
        bits: 8,
        offset: 8,
        processor: {type: 'direct'},
      },
      {
        name: 'productCategoryId',
        outputName: 'productCategoryId',
        bits: 8,
        offset: 16,
        processor: {type: 'direct'},
      },
      {
        name: 'campaignId',
        outputName: 'campaignId',
        bits: 16,
        offset: 24,
        processor: {type: 'direct'},
      },
    ],
  },
  // --- Add configurations for other USE_CASE IDs ---
};

// --- Helper Function: Decode Aggregation Key ---

/**
 * Decodes a BigInt aggregation key string based on the predefined configuration
 * for a specific expected use case.
 *
 * @param {string} bucketString - The aggregation key (bucket) as a string (decimal or hex).
 * @param {number} expectedUseCaseId - The Use Case ID this function should specifically decode.
 * @returns {object | null} An object containing the decoded dimensions { useCaseId, dim1Name, dim2Name, ... }
 * or null if the bucket is not for the expected use case or decoding fails.
 */
function decodeAggregationKey(bucketString, expectedUseCaseId) {
  try {
    const bucketBigInt = BigInt(bucketString); // Handles decimal and "0x" hex strings

    // 1. Extract Use Case ID from lowest bits
    const useCaseMask = (1n << BigInt(USE_CASE_ID_BITS)) - 1n;
    const useCaseId = Number(bucketBigInt & useCaseMask);

    // 2. Verify it matches the expected Use Case ID
    if (useCaseId !== expectedUseCaseId) {
      // console.debug(`[decode] Skipping bucket ${bucketString}: Incorrect use case ID ${useCaseId}, expected ${expectedUseCaseId}`);
      return null; // Not the key type we're looking for in this context
    }

    // 3. Get the configuration for the expected use case
    const config = AGGREGATION_KEY_CONFIG[expectedUseCaseId];
    if (!config || !config.dimensions || !Array.isArray(config.dimensions)) {
      console.error(
        `[decode] Missing or invalid config for Use Case ID: ${expectedUseCaseId}`,
      );
      return null;
    }

    const decodedDimensions = {useCaseId}; // Start with the verified use case ID

    // 4. Extract each dimension based on its configured offset and bits
    for (const dimConfig of config.dimensions) {
      // Use outputName if provided (e.g., cpmBinId), otherwise use the input name
      const nameToUse = dimConfig.outputName || dimConfig.name;
      const {bits, offset} = dimConfig;

      // Create a mask for the bits allocated to this dimension
      const mask = (1n << BigInt(bits)) - 1n;
      // Shift the key right by the offset, then apply the mask
      const value = Number((bucketBigInt >> BigInt(offset)) & mask);
      decodedDimensions[nameToUse] = value;
    }

    return decodedDimensions; // e.g., { useCaseId: 1, cpmBinId: 3, buyerMappedId: 1, publisherId: 5 }
  } catch (e) {
    console.error(
      `[decode] Error decoding bucket string "${bucketString}" for use case ${expectedUseCaseId}:`,
      e,
    );
    return null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  console.log('chart-reports.js loaded (expecting server-decoded data)');

  // --- Configuration & Constants ---
  const BUYER_MAP = {
    'https://privacy-sandbox-demos-dsp-a.dev': 1, // Buyer A ID = 1
    'https://privacy-sandbox-demos-dsp-b.dev': 2, // Buyer B ID = 2
    'https://privacy-sandbox-demos-dsp.dev': 3, // Generic DSP ID = 3
  };
  const BUYER_REV_MAP = {
    0: 'Unknown/Other',
    1: 'DSP A (dsp-a.dev)',
    2: 'DSP B (dsp-b.dev)',
    3: 'DSP (dsp.dev)',
  };
  const CPM_BIN_SIZE = 0.5;
  const MAX_CPM_FOR_BINNING = 10.0;
  const NUM_CPM_BINS = MAX_CPM_FOR_BINNING / CPM_BIN_SIZE; // 20 bins
  const BUYER_SHIFT = 5n; // Bit shift used in key generation

  // DOM Elements & State
  const chartCanvas = document.getElementById('bidDensityChart');
  const filterSelect = document.getElementById('dspFilter');
  const rawDataPre = document.getElementById('reportData');
  const clearLink = document.getElementById('clearReportsLink');
  let bidChart = null;
  let allAggregatedData = {}; // Structure: { buyerId: number[], ... }

  // --- CBOR Decoding Removed ---
  // No longer needed as the server handles decoding.

  // --- Bucket Key Parsing ---
  /**
   * Parses the combined bucket key (now received as a string from server)
   * back into buyer ID and CPM index.
   * @param {string} keyString - The combined bucket key as a string.
   * @returns {{cpmIndex: number, buyerId: number} | null} - Parsed indices or null if invalid.
   */
  function parseBidDensityBucketKey(keyString) {
    try {
      // Convert the string key back to BigInt for parsing
      const key = BigInt(keyString);

      // Mask to extract the lower bits used for CPM index
      const cpmIndexMask = (1n << BUYER_SHIFT) - 1n;
      // Extract CPM index by applying the mask
      const cpmIndex = Number(key & cpmIndexMask);
      // Extract buyer ID by shifting the key right
      const buyerId = Number(key >> BUYER_SHIFT);

      // Basic validation: Check if CPM index is within the expected range
      if (cpmIndex < 0 || cpmIndex >= NUM_CPM_BINS) {
        // console.warn("Parsed CPM index out of bounds:", cpmIndex, "from key string:", keyString);
        return null;
      }
      return {cpmIndex, buyerId};
    } catch (e) {
      console.error('Error parsing bucket key string:', keyString, e);
      return null;
    }
  }

  // --- Data Aggregation ---

  // Constants derived from the BID_DENSITY configuration (Use Case 1)
  const BID_DENSITY_USE_CASE_ID = USE_CASES.BID_DENSITY;
  // CPM Bins: Config uses 5 bits => 2^5 = 32 possible bins (Indices 0-31).
  // The actual number used depends on the binning logic (maxThreshold=10.0, binSize=0.5 => Indices 0-19 used)
  const NUM_CPM_BINS_CONFIGURED = 20; // Based on $10 / $0.50 = 20 bins
  // Reverse map for Buyer IDs (Must match the mapping in AGGREGATION_KEY_CONFIG for BID_DENSITY)
  const BID_DENSITY_BUYER_REV_MAP = {
    1: 'dsp-a', // Mapped ID 1 -> Name 'dsp-a'
    2: 'dsp-b', // Mapped ID 2 -> Name 'dsp-b'
    3: 'dsp', // Mapped ID 3 -> Name 'dsp'
    // ID 0 (defaultValue) will be filtered out below
  };

  /**
   * Processes raw reports containing pre-decoded contributions using the new standardized keys.
   * Specifically aggregates data for the BID_DENSITY use case.
   * @param {Array<object>} rawReports - Array of report objects from the server/EJS,
   * expected to have report.data.decodedContributions array.
   */
  function aggregateData(rawReports) {
    allAggregatedData = {}; // Reset results
    console.log(
      `Processing ${rawReports.length} raw reports for Bid Density aggregation...`,
    );
    let processedContributions = 0;
    let reportsWithContributions = 0;
    let skippedOtherUseCases = 0;
    let skippedDecodeErrors = 0;
    let skippedInvalidData = 0;

    for (const report of rawReports) {
      // Adjust path based on how server provides decoded data
      const decodedContributions = report?.data?.decodedContributions;

      if (decodedContributions && Array.isArray(decodedContributions)) {
        reportsWithContributions++;
        for (const contribution of decodedContributions) {
          // Basic validation of contribution format
          if (
            !contribution ||
            typeof contribution.bucket !== 'string' ||
            typeof contribution.value !== 'number'
          ) {
            console.warn(
              `Skipping contribution with invalid format:`,
              contribution,
            );
            skippedInvalidData++;
            continue;
          }

          const {bucket: bucketString, value} = contribution;

          // Decode the bucket string *specifically for BID_DENSITY keys*
          const parsedKey = decodeAggregationKey(
            bucketString,
            BID_DENSITY_USE_CASE_ID,
          );

          if (parsedKey) {
            // Successfully decoded a key matching the BID_DENSITY use case

            // Extract dimensions needed for this aggregation structure
            // Note: parsedKey contains { useCaseId: 1, cpmBinId: N, buyerMappedId: M, publisherId: P }
            const {cpmBinId, buyerMappedId /*, publisherId */} = parsedKey;
            // publisherId is available but not used in the allAggregatedData structure here

            // Filter out contributions from the default/unknown buyer (ID 0)
            // and those not explicitly mapped in our reverse map for charting
            if (
              buyerMappedId !== 0 &&
              BID_DENSITY_BUYER_REV_MAP.hasOwnProperty(buyerMappedId)
            ) {
              // Ensure cpmBinId is within the expected range based on config
              if (cpmBinId >= 0 && cpmBinId < NUM_CPM_BINS_CONFIGURED) {
                // Initialize the array for this buyer if it's the first time
                if (!allAggregatedData[buyerMappedId]) {
                  allAggregatedData[buyerMappedId] = Array(
                    NUM_CPM_BINS_CONFIGURED,
                  ).fill(0);
                }

                // Add the value from the contribution to the correct bin
                allAggregatedData[buyerMappedId][cpmBinId] += value;
                processedContributions++;
              } else {
                console.warn(
                  `Invalid cpmBinId ${cpmBinId} from bucket ${bucketString}. Expected 0-${NUM_CPM_BINS_CONFIGURED - 1}. Skipping.`,
                );
                skippedInvalidData++;
              }
            } else {
              // console.debug(`Ignoring contribution: Buyer ID ${buyerMappedId} is default or not in reverse map.`);
              skippedInvalidData++;
            }
          } else {
            // decodeAggregationKey returned null. This means either:
            // 1. The bucket string was invalid / couldn't be parsed to BigInt.
            // 2. The useCaseId didn't match BID_DENSITY_USE_CASE_ID.
            // We only count skips if it wasn't a basic parse error (logged by decoder)
            if (
              decodeAggregationKey(
                bucketString,
                BID_DENSITY_USE_CASE_ID + 1,
              ) === null &&
              !isNaN(Number(bucketString))
            ) {
              // Crude check if it was likely a different use case
              skippedOtherUseCases++;
            } else {
              skippedDecodeErrors++; // Likely a format/parsing error
            }
            // console.warn(`Could not decode bucket key string or wrong use case: "${bucketString}"`);
          }
        } // end loop through contributions
      }
      // else { console.debug("Report skipped - no valid decodedContributions array found."); }
    } // end loop through reports

    console.log(
      `Bid Density Aggregation complete.\n` +
        `Reports with contributions: ${reportsWithContributions}\n` +
        `Processed valid contributions: ${processedContributions}\n` +
        `Skipped (Other Use Cases): ${skippedOtherUseCases}\n` +
        `Skipped (Decode/Format Error): ${skippedDecodeErrors}\n` +
        `Skipped (Invalid Data/Filter): ${skippedInvalidData}\n` +
        `Final data structure:`,
      JSON.parse(JSON.stringify(allAggregatedData)), // Deep copy for logging
    );
  }

  // --- Chart Rendering ---
  /**
   * Generates labels for the CPM bins (e.g., "$0.00 - $0.50").
   * @returns {Array<string>} - Array of labels.
   */
  function getCpmBinLabels() {
    const labels = [];
    for (let i = 0; i < NUM_CPM_BINS; i++) {
      const start = (i * CPM_BIN_SIZE).toFixed(2);
      const end = ((i + 1) * CPM_BIN_SIZE).toFixed(2);
      labels.push(`$${start} - $${end}`);
    }
    return labels;
  }

  /**
   * Renders or updates the Chart.js chart based on aggregated data and filter selection.
   * @param {string | number} selectedBuyerId - The ID of the buyer to display, or 'all'.
   */
  function renderChart(selectedBuyerId = 'all') {
    if (!chartCanvas) {
      console.error('Chart canvas element not found');
      return;
    }
    console.log('Rendering chart for buyer:', selectedBuyerId);

    const labels = getCpmBinLabels();
    const chartDataCounts = Array(NUM_CPM_BINS).fill(0); // Initialize counts for all bins

    if (selectedBuyerId === 'all') {
      // Sum counts across all *known* buyers defined in BUYER_MAP
      Object.keys(BUYER_MAP).forEach((key) => {
        const buyerId = BUYER_MAP[key];
        if (allAggregatedData[buyerId]) {
          for (let i = 0; i < NUM_CPM_BINS; i++) {
            chartDataCounts[i] += allAggregatedData[buyerId][i] || 0;
          }
        }
      });
    } else {
      // Use data only for the selected buyer
      const buyerIdNum = parseInt(selectedBuyerId, 10);
      if (allAggregatedData[buyerIdNum]) {
        for (let i = 0; i < NUM_CPM_BINS; i++) {
          chartDataCounts[i] = allAggregatedData[buyerIdNum][i] || 0;
        }
      }
    }

    const chartTitle =
      selectedBuyerId === 'all'
        ? 'Overall Bid Density (All Known DSPs)'
        : `Bid Density for ${BUYER_REV_MAP[selectedBuyerId] || `ID ${selectedBuyerId}`}`;

    if (bidChart) {
      bidChart.destroy();
    }

    bidChart = new Chart(chartCanvas, {
      type: 'bar',
      height: '500',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Bid Count',
            data: chartDataCounts,
            backgroundColor: 'rgba(75, 192, 192, 0.6)',
            borderColor: 'rgba(75, 192, 192, 1)',
            borderWidth: 1,
          },
        ],
      },
      options: {
        scales: {
          y: {
            beginAtZero: true,
            title: {display: true, text: 'Number of Bids'},
          },
          x: {title: {display: true, text: 'CPM Bin (USD)'}},
        },
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {display: false},
          title: {display: true, text: chartTitle},
          tooltip: {enabled: true},
        },
      },
    });
  }

  // --- Event Listeners and Initialization ---
  /**
   * Populates the DSP filter dropdown and adds change listener.
   */
  function setupFilter() {
    if (!filterSelect) {
      console.warn('Filter select element (#dspFilter) not found');
      return;
    }
    filterSelect.innerHTML = ''; // Clear existing

    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'All Known DSPs';
    filterSelect.appendChild(allOption);

    Object.keys(BUYER_REV_MAP).forEach((idStr) => {
      const buyerId = parseInt(idStr, 10);
      if (buyerId !== 0) {
        // Only add known DSPs
        const option = document.createElement('option');
        option.value = buyerId;
        option.textContent = BUYER_REV_MAP[buyerId];
        filterSelect.appendChild(option);
      }
    });

    filterSelect.addEventListener('change', (event) => {
      renderChart(event.target.value);
    });
  }

  /**
   * Adds event listener for the clear cache link.
   */
  function setupClearLink() {
    if (clearLink) {
      clearLink.addEventListener('click', (event) => {
        event.preventDefault();
        if (
          !confirm(
            'Are you sure you want to clear the report cache on the server?',
          )
        ) {
          return;
        }
        console.log('Requesting report cache clear...');
        fetch('/reporting/clear-reports', {method: 'POST'}) // Use POST or method expected by server
          .then((response) => {
            if (!response.ok) {
              return response.text().then((text) => {
                throw new Error(
                  `Clear failed: ${response.status} ${response.statusText}. ${text || ''}`,
                );
              });
            }
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              return response.json();
            } else {
              return response.text();
            }
          })
          .then((data) => {
            console.log('Cache clear successful:', data);
            alert('Cache cleared successfully! Reloading page.');
            location.reload();
          })
          .catch((error) => {
            console.error('Error clearing report cache:', error);
            alert(`Failed to clear cache: ${error.message}`);
          });
      });
    } else {
      console.warn('Clear reports link element (#clearReportsLink) not found');
    }
  }

  // --- Main Execution ---
  /**
   * Initializes the report processing and chart rendering.
   */
  function main() {
    if (!rawDataPre) {
      console.error('Raw data element (<pre id="reportData">) not found.');
      return;
    }
    if (!chartCanvas) {
      console.error(
        'Chart canvas element (<canvas id="bidDensityChart">) not found.',
      );
      return;
    }

    let rawReports = [];
    try {
      const jsonData = rawDataPre.textContent || '[]';
      if (!jsonData.trim() || jsonData === '[]') {
        console.warn('No embedded report data found or data is empty.');
      } else {
        rawReports = JSON.parse(jsonData);
        // Expect server to have added report.data.decodedContributions
      }
    } catch (e) {
      console.error('Failed to parse embedded report data:', e);
      rawDataPre.textContent = `Error parsing embedded JSON data: ${e.message}`;
      return;
    }

    // Process the data (now expects pre-decoded contributions)
    // Note: aggregateData is now synchronous as decodePayload was removed
    aggregateData(rawReports);

    // Setup UI elements
    setupFilter();
    setupClearLink();

    // Render the initial chart
    renderChart('all');
  }

  // Run the initialization logic
  main();
});
