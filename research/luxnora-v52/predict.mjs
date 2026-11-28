function unpack({scale, values}) {
  return Float32Array.from(values, value => value * (scale || 1));
}

function dense(input, weights, bias) {
  return Array.from(bias, (value, row) => {
    for (let i = 0; i < input.length; i++) value += weights[row * input.length + i] * input[i];
    return value;
  });
}

function ngrams(characters, bins) {
  const wrapped = ["^", ...characters, "$"];
  const hashes = new Set();
  for (let start = 0; start < wrapped.length; start++) {
    let hash = 0;
    for (let i = start; i < Math.min(start + 3, wrapped.length); i++) {
      hash = (hash * 31 + wrapped[i].codePointAt(0)) % bins;
      hashes.add(hash);
    }
  }
  const input = new Float32Array(bins);
  for (const index of hashes) input[index] = 1 / Math.sqrt(hashes.size);
  return input;
}

function pool(ids, weights) {
  const maximum = Array(32).fill(0);
  const average = Array(32).fill(0);
  for (let channel = 0; channel < 32; channel++) {
    for (let position = 0; position < ids.length; position++) {
      let value = weights["conv.bias"][channel];
      for (let offset = 0; offset < 3; offset++) {
        const id = ids[position + offset - 1];
        if (id === undefined) continue;
        for (let feature = 0; feature < 24; feature++) {
          value += weights["embed.weight"][id * 24 + feature] *
            weights["conv.weight"][(channel * 24 + feature) * 3 + offset];
        }
      }
      value = Math.max(0, value);
      average[channel] += value / ids.length;
      maximum[channel] = Math.max(maximum[channel], value);
    }
  }
  return [...maximum, ...average];
}

export function createPredictor(model) {
  const weights = Object.fromEntries(Object.entries(model.weights).map(([key, tensor]) => [key, unpack(tensor)]));
  return (raw, context) => {
    const characters = Array.from(raw.normalize("NFKC").toLowerCase().trim());
    const state = new Set(Object.entries(context).map(([key, value]) =>
      key + "=" + (typeof value === "boolean" ? (value ? "True" : "False") : value)));
    const features = [];
    if (model.kind === "cnn" || model.kind === "fusion") {
      const ids = characters.slice(0, model.length).map(char => model.vocabulary[char] ?? 1);
      features.push(...pool(ids, weights));
    }
    if (model.kind !== "cnn") features.push(...ngrams(characters, model.bins));
    features.push(...model.attributes.map(attribute => Number(state.has(attribute))));
    const hidden = model.kind === "linear" ? features
      : dense(features, weights["encoder.0.weight"], weights["encoder.0.bias"]).map(value => Math.max(0, value));
    const logits = dense(hidden, weights["head.weight"], weights["head.bias"]);
    let offset = 0;
    const categories = model.heads.map(head => {
      const values = logits.slice(offset, offset + head.length);
      offset += head.length;
      return values.indexOf(Math.max(...values));
    });
    const cutoff = Math.log(model.threshold / (1 - model.threshold));
    return {categories, binary: logits.slice(offset).map(value => value >= cutoff)};
  };
}
