import json
import os

def generate_test_cases(visual_dom):
    elements = visual_dom["elements"]

    steps = []
    
    for el in elements:
        if el["type"] == "input":
            steps.append({
                "action": "fill",
                "target": el["text"],
                "value": "test_value"
            })
        elif el["type"] == "button":
            steps.append({
                "action": "click",
                "target": el["text"]
            })

    test_case = {
        "objective": f"Test {visual_dom['screen']}",
        "steps": steps,
        "expected_result": "User completes flow successfully"
    }

    return test_case


if __name__ == "__main__":
    base_dir = os.path.dirname(os.path.abspath(__file__))
    input_path = os.path.join(base_dir, "../logs/sample_visual_dom.json")
    output_path = os.path.join(base_dir, "../logs/mobile_test_cases.json")

    with open(input_path) as f:
        visual_dom = json.load(f)

    test_case = generate_test_cases(visual_dom)

    with open(output_path, "w") as f:
        json.dump(test_case, f, indent=2)

    print("✅ Test case generated")