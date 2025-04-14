document.addEventListener('DOMContentLoaded', () => {
  console.log('chart-rejection.js V2 Structure for Stacked Histogram loaded');

  // --- Configuration & Constants for Bid Rejection (STACKED HISTOGRAM VERSION) ---

  // ** CPM Binning Adjusted for 10 Bins ($1 width) **
  const CPM_BIN_SIZE = 1.0;
  const MAX_CPM_FOR_BINNING = 10.0;
  const NUM_CPM_BINS = 10; // $0-1, $1-2, ..., $9-10 (Indices 0-9)

  // ** Bit Allocation Recalculated **
  const REJECTION_REASON_BITS = 5n; // Bits 0-4  (0-31) - No change
  const CPM_INDEX_BITS = 4n; // Bits 5-8  (Needs 4 bits for 0-9) - CHANGED
  const PUBLISHER_ID_BITS = 2n; // Bits 9-10 (0-3) - No change needed here, but position changes

  // ** Shifts Recalculated **
  const CPM_INDEX_SHIFT = REJECTION_REASON_BITS; // 5n - No change
  const PUBLISHER_ID_SHIFT = CPM_INDEX_SHIFT + CPM_INDEX_BITS; // 5n + 4n = 9n - CHANGED

  // ** Masks Recalculated **
  const REJECTION_REASON_MASK = (1n << REJECTION_REASON_BITS) - 1n; // Mask for bits 0-4 - No change
  const CPM_INDEX_MASK = (1n << CPM_INDEX_BITS) - 1n; // Mask for bits 0-3 (before shifting) - CHANGED
  const PUBLISHER_ID_MASK = (1n << PUBLISHER_ID_BITS) - 1n; // Mask for bits 0-1 (before shifting) - No change

  // Mapping for Rejection Reasons (Same as before)
  const REJECTION_REASON_MAP = {
    0: 'not-available',
    1: 'invalid-bid',
    2: 'bid-below-auction-floor',
    3: 'pending-approval-by-exchange',
    4: 'disapproved-by-exchange',
    5: 'blocked-by-publisher',
    6: 'language-exclusions',
    7: 'category-exclusions',
    8: 'k-anonymity-enforced',
    9: 'wrong-currency',
    10: 'creative-size-mismatch',
    // Add potentially more reasons up to ID 31
    31: 'unknown-reason-max-value',
  };
  const REJECTION_REASON_COUNT = 32; // 2^5

  // Mapping for Publisher IDs (Example, same as before)
  const PUBLISHER_REV_MAP = {
    0: 'Unknown/Other',
    1: 'Publisher A (news.dev)',
    2: 'Publisher B (pubB.com)',
    3: 'Publisher C (pubC.com)',
  };
  const PUBLISHER_COUNT = 4; // 2^2

  // Colors for chart stacks (using V2 example colors)
  const STACK_COLORS = [
    'rgba(128, 128, 128, 0.7)',
    'rgba(54, 162, 235, 0.7)',
    'rgba(255, 206, 86, 0.7)',
    'rgba(255, 159, 64, 0.7)',
    'rgba(199, 199, 199, 0.7)',
    'rgba(83, 102, 255, 0.7)',
    'rgba(255, 99, 71, 0.7)',
    'rgba(128, 0, 128, 0.7)',
    'rgba(0, 255, 0, 0.7)',
    'rgba(255, 255, 0, 0.7)',
    'rgba(0, 255, 255, 0.7)',
    // Add more colors if more than 11 reasons are common
    'rgba(210, 105, 30, 0.7)',
    'rgba(127, 255, 0, 0.7)',
    'rgba(0, 128, 0, 0.7)',
    'rgba(75, 0, 130, 0.7)',
    'rgba(255, 20, 147, 0.7)',
  ];

  // --- V2 Structure: DOM Elements & State ---
  const chartCanvas = document.getElementById('bidRejectionChart'); // Ensure ID matches EJS
  const rawDataPre = document.getElementById('reportData');
  const clearLink = document.getElementById('clearReportsLink');
  let rejectionChart = null; // Chart instance
  // Structure: { rejectionReasonId: countsPerCpmBin[NUM_CPM_BINS] }
  let allAggregatedData = {};

  // --- Bucket Key Parsing ---
  // Uses the recalculated constants (shifts, masks)
  function parseBidRejectionBucketKey(keyString) {
    try {
      const key = BigInt(keyString);
      const rejectionReasonId = Number(key & REJECTION_REASON_MASK);
      const cpmIndex = Number((key >> CPM_INDEX_SHIFT) & CPM_INDEX_MASK); // Uses new shift/mask
      const publisherId = Number(
        (key >> PUBLISHER_ID_SHIFT) & PUBLISHER_ID_MASK,
      ); // Uses new shift/mask

      // Validation using new NUM_CPM_BINS
      if (
        rejectionReasonId < 0 ||
        rejectionReasonId >= REJECTION_REASON_COUNT ||
        cpmIndex < 0 ||
        cpmIndex >= NUM_CPM_BINS || // Check against 10 bins
        publisherId < 0 ||
        publisherId >= PUBLISHER_COUNT
      ) {
        console.warn(
          'Parsed key component out of bounds for key:',
          keyString,
          `Reason ${rejectionReasonId}, CPM ${cpmIndex}, Pub ${publisherId}`,
        );
        return null;
      }
      return {rejectionReasonId, cpmIndex, publisherId};
    } catch (e) {
      console.error(
        'Error parsing bid rejection bucket key string:',
        keyString,
        e,
      );
      return null;
    }
  }

  // --- Data Aggregation (Client-Side for Stacked Chart) ---
  /**
   * Processes raw reports containing pre-decoded contributions.
   * Aggregates counts per rejection reason per CPM bin.
   * @param {Array<object>} rawReports - Array of report objects from the server/EJS.
   * @returns {object} - Aggregated data: { rejectionReasonId: countsPerCpmBin[NUM_CPM_BINS] }
   */
  function aggregateData(rawReports) {
    const aggregated = {}; // Local aggregation object
    // Initialize structure: { reasonId: [0, 0, ..., 0] } (length NUM_CPM_BINS)
    Object.keys(REJECTION_REASON_MAP).forEach((id) => {
      aggregated[id] = Array(NUM_CPM_BINS).fill(0);
    });

    console.log(
      `Processing ${rawReports.length} raw reports for Stacked Bid Rejection...`,
    );
    let processedContributions = 0;

    for (const report of rawReports) {
      const decodedContributions = report?.data?.decodedContributions;
      if (decodedContributions && Array.isArray(decodedContributions)) {
        for (const {bucket: bucketString, value} of decodedContributions) {
          const parsedKey = parseBidRejectionBucketKey(bucketString);
          if (parsedKey) {
            const {rejectionReasonId, cpmIndex} = parsedKey;
            // Check if the reason ID is one we are tracking
            if (aggregated.hasOwnProperty(rejectionReasonId)) {
              // cpmIndex is already validated to be within [0, NUM_CPM_BINS-1] by parser
              aggregated[rejectionReasonId][cpmIndex] += value;
              processedContributions++;
            } else {
              console.warn(
                `Parsed key with unknown rejectionReasonId ${rejectionReasonId}. Ignoring.`,
              );
            }
          }
        }
      }
    }
    console.log(
      `Client-side aggregation complete. Processed ${processedContributions} valid contributions for stacked chart.`,
    );
    return aggregated;
  }

  // --- Chart Initialization (Stacked Bar) ---
  function initChart() {
    console.log('Initializing stacked rejection chart');
    if (!chartCanvas) {
      console.error(
        'Chart canvas element (#bidRejectionChart) not found during init.',
      );
      return;
    }
    const ctx = chartCanvas.getContext('2d');

    // Labels for the X-axis (CPM Bins $0-$10)
    const labels = Array.from({length: NUM_CPM_BINS}, (_, i) => {
      const start = (i * CPM_BIN_SIZE).toFixed(0); // Use 1.0 bin size
      const end = ((i + 1) * CPM_BIN_SIZE).toFixed(0);
      return `$${start}-$${end}`; // Labels like $0-$1, $1-$2, etc.
    });

    // Create one dataset per rejection reason
    const datasets = Object.keys(REJECTION_REASON_MAP)
      .map((idStr, index) => {
        const id = parseInt(idStr, 10);
        return {
          label: `${REJECTION_REASON_MAP[id]} (${id})`, // Legend label
          data: Array(NUM_CPM_BINS).fill(0), // Initialize counts for this reason across all CPM bins
          backgroundColor: STACK_COLORS[index % STACK_COLORS.length], // Assign color
          // Store the reason ID for easy access during update
          rejectionReasonId: id,
        };
      })
      .sort((a, b) => a.rejectionReasonId - b.rejectionReasonId); // Sort datasets by ID for consistency

    rejectionChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels, // CPM Bins on X-axis
        datasets: datasets, // One dataset per rejection reason
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Stacked Bid Rejection Counts by CPM Bin',
          },
          legend: {position: 'right', labels: {boxWidth: 12}}, // Position legend
        },
        scales: {
          x: {
            // CPM Bin axis
            stacked: true, // Stack bars on this axis
            title: {display: true, text: 'Bid CPM Bin (USD)'},
          },
          y: {
            // Count axis
            stacked: true, // Stack bars on this axis
            beginAtZero: true,
            title: {display: true, text: 'Number of Rejections'},
          },
        },
      },
    });
    console.log('Stacked rejection chart initialized.');
  }

  // --- Chart Update (Stacked Bar) ---
  /**
   * Updates the stacked chart with newly aggregated data.
   * @param {object} aggregatedCounts - Object like { rejectionReasonId: countsPerCpmBin[] }
   */
  function updateChart(aggregatedCounts) {
    if (!rejectionChart) {
      console.error('Chart not initialized, cannot update.');
      return;
    }
    console.log(
      'Updating stacked chart with aggregated data:',
      aggregatedCounts,
    );

    // Update each dataset (each representing a rejection reason)
    rejectionChart.data.datasets.forEach((dataset) => {
      const reasonId = dataset.rejectionReasonId; // Get the reason ID stored during init
      if (aggregatedCounts.hasOwnProperty(reasonId)) {
        // Update the data array for this dataset with the counts for each CPM bin
        dataset.data = aggregatedCounts[reasonId];
      } else {
        // If no data for this reason, ensure it's zeros
        dataset.data = Array(NUM_CPM_BINS).fill(0);
        console.warn(
          `No aggregated data found for rejection reason ID ${reasonId}. Setting counts to zero.`,
        );
      }
    });

    rejectionChart.update();
    console.log('Stacked chart updated.');
  }

  // --- Main Execution Flow ---
  function run() {
    console.log('Running main execution flow for stacked chart...');
    initChart(); // Create the empty chart structure first

    // Get Data from Embedded Source
    if (!rawDataPre) {
      console.error('Raw data element (<pre id="reportData">) not found.');
      return;
    }
    let rawReports = [];
    try {
      const jsonData = rawDataPre.textContent || '[]';
      if (jsonData.trim() && jsonData !== '[]') {
        rawReports = JSON.parse(jsonData);
      }
    } catch (e) {
      console.error('Failed to parse embedded report data:', e);
      return;
    }

    // Aggregate Data Client-Side for Stacked Chart
    allAggregatedData = aggregateData(rawReports);

    // Update Chart with Aggregated Data
    updateChart(allAggregatedData);
  }

  // Run the application
  run();
  console.log('Stacked Bid Rejection Chart script initialization complete.');
}); // End DOMContentLoaded
