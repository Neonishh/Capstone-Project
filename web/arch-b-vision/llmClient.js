// llmClient.js
// Stub for LLM reasoning over visual DOM

async function llmReason(visualDOM) {
    // Simulate LLM: pick the first detected object (if any)
    if (visualDOM && visualDOM.yolo && visualDOM.yolo.length > 0) {
        const obj = visualDOM.yolo[0];
        // Center of bounding box
        const x = Math.floor((obj.bbox[0] + obj.bbox[2]) / 2);
        const y = Math.floor((obj.bbox[1] + obj.bbox[3]) / 2);
        return { x, y, actionType: 'click' };
    }
    return null;
}

module.exports = { llmReason };
