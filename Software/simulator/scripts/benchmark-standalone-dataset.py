"""Train reference Ridge and LSTM models on the synthetic standalone-node dataset."""
import argparse
import json
from pathlib import Path

import joblib
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset


FIELDS = (
    "soilMoistureVwc", "soilTemperatureC", "airTemperatureC", "airHumidityPct",
    "quality", "irrigationCommandMm", "ageDays", "et0MmDay",
)
CROPS = ("mustard-greens", "chilli", "tomato")
HORIZONS = (6, 168)
HISTORY = 12


class MoistureLSTM(nn.Module):
    def __init__(self, inputs):
        super().__init__()
        self.recurrent = nn.LSTM(inputs, 32, batch_first=True)
        self.output = nn.Linear(32, len(HORIZONS))

    def forward(self, inputs):
        hidden, _ = self.recurrent(inputs)
        return self.output(hidden[:, -1])


def load_data(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    runs = {run["runId"]: run for run in manifest["runs"]}
    groups = {split: ([], [], [], [], []) for split in ("train", "validation", "test")}
    with (directory / "observations.jsonl").open() as observed, (directory / "labels.jsonl").open() as labels:
        for run_id, run in runs.items():
            history, target = [], []
            node = run["config"]["nodes"][0]
            crop = node["cropId"]
            for sequence in range(1, manifest["hoursPerRun"] + 1):
                reading, label = json.loads(next(observed)), json.loads(next(labels))
                key = (run_id, node["id"], sequence)
                for row in (reading, label):
                    assert (row["runId"], row["nodeId"], row["sequence"]) == key
                values = [reading[field] for field in FIELDS]
                present = reading["soilMoistureVwc"] is not None
                history.append([value if value is not None else 0.0 for value in values] +
                               [float(present), *[float(crop == item) for item in CROPS]])
                target.append(label["soilMoistureVwc"])

            features, future, current, crops, families = groups[run["split"]]
            for index in range(HISTORY - 1, len(history) - max(HORIZONS)):
                sample = history[index]
                if not sample[len(FIELDS)]:
                    continue
                features.append(history[index - HISTORY + 1:index + 1])
                future.append([target[index + horizon] for horizon in HORIZONS])
                current.append(sample[0])
                crops.append(crop)
                families.append(run["family"])
        assert not observed.readline() and not labels.readline()
    return {split: tuple(np.asarray(column) for column in columns) for split, columns in groups.items()}


def tensor(values):
    return torch.as_tensor(values, dtype=torch.float32)


def score(truth, prediction):
    return {str(hour): round(float(error), 4)
            for hour, error in zip(HORIZONS, np.abs(truth - prediction).mean(axis=0))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(42)
    torch.set_num_threads(2)
    groups = load_data(args.dataset)
    train, train_future, train_current, _, _ = groups["train"]
    valid, valid_future, valid_current, _, _ = groups["validation"]
    test, test_future, test_current, test_crops, test_families = groups["test"]
    shape = train.shape[-1]
    scaler = StandardScaler().fit(train.reshape(-1, shape))

    def standardize(values):
        return scaler.transform(values.reshape(-1, shape)).reshape(values.shape)

    train, valid, test = map(standardize, (train, valid, test))
    delta = train_future - train_current[:, None]
    ridge = Ridge(alpha=10).fit(train.reshape(len(train), -1), delta)
    joblib.dump({"model": ridge, "scaler": scaler, "history": HISTORY, "horizons": HORIZONS},
                args.output / "ridge.joblib")

    lstm = MoistureLSTM(shape)
    optimizer = torch.optim.Adam(lstm.parameters(), lr=0.003)
    loss = nn.MSELoss()
    loader = DataLoader(TensorDataset(tensor(train), tensor(delta)), batch_size=256, shuffle=True)
    valid_values = tensor(valid)
    best_error, best_epoch, best = float("inf"), 0, None
    for epoch in range(1, 13):
        lstm.train()
        for features, target in loader:
            optimizer.zero_grad()
            loss(lstm(features), target).backward()
            optimizer.step()
        lstm.eval()
        with torch.no_grad():
            prediction = lstm(valid_values).numpy() + valid_current[:, None]
        error = np.abs(valid_future - prediction).mean()
        if error < best_error:
            best_error, best_epoch = float(error), epoch
            best = {key: value.detach().clone() for key, value in lstm.state_dict().items()}
    lstm.load_state_dict(best)
    torch.save({"weights": best, "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
                "fields": FIELDS, "crops": CROPS, "history": HISTORY, "horizons": HORIZONS},
               args.output / "lstm.pt")
    with torch.no_grad():
        lstm_delta = lstm(tensor(test)).numpy()

    predictions = {
        "persistence": np.broadcast_to(test_current[:, None], test_future.shape),
        "ridge": np.clip(ridge.predict(test.reshape(len(test), -1)) + test_current[:, None], 0, 100),
        "lstm": np.clip(lstm_delta + test_current[:, None], 0, 100),
    }

    def breakdown(groups_by, values):
        return {value: {name: score(test_future[groups_by == value], pred[groups_by == value])
                        for name, pred in predictions.items()} for value in values}

    results = {
        "sourceType": "synthetic",
        "metric": "MAE in VWC percentage points",
        "inputHours": HISTORY,
        "targetHours": HORIZONS,
        "windows": {split: len(data[0]) for split, data in groups.items()},
        "selectedLstmEpoch": best_epoch,
        "test": {name: score(test_future, pred) for name, pred in predictions.items()},
        "byCrop": breakdown(test_crops, CROPS),
        "byScenario": breakdown(test_families, sorted(set(test_families))),
    }
    (args.output / "metrics.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results["test"], indent=2))


if __name__ == "__main__":
    main()
