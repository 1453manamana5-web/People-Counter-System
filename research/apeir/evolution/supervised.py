"""Multitask sequence learning with separate model-selection and final worlds."""
import argparse
from pathlib import Path

import numpy as np
import torch
from torch import nn

from world import ApeirWorld, SHAPE, TRAIN_START, VALID_START, rules

torch.set_num_threads(1)


class Specialist(nn.Module):
    def __init__(self, architecture):
        super().__init__()
        self.architecture = architecture
        if architecture == "mlp":
            self.encoder = nn.Sequential(nn.Flatten(), nn.Linear(np.prod(SHAPE), 64),
                                         nn.ReLU(), nn.Linear(64, 32), nn.ReLU())
        else:
            cell = {"gru": nn.GRU, "lstm": nn.LSTM}[architecture]
            self.encoder = cell(SHAPE[1], 32, num_layers=2, batch_first=True)
        self.output = nn.Linear(32, 11)

    def forward(self, history):
        state = self.encoder(history) if self.architecture == "mlp" else self.encoder(history)[0][:, -1]
        return self.output(state)


def dataset(start, episodes, distribution="train"):
    env = ApeirWorld(distribution=distribution)
    histories, actions, faults, problems, future = [], [], [], [], []
    rng = np.random.default_rng(start)
    for seed in range(start, start+episodes):
        obs, _ = env.reset(seed=seed)
        done = False
        while not done:
            act = env.teacher()
            policy = act if rng.random()<.64 else rules(obs)[0] if rng.random()<.75 else int(rng.integers(5))
            nxt, _, term, trunc, info = env.step(policy)
            histories.append(obs)
            actions.append(act)
            faults.append(info["faults"])
            problems.append(info["problem"])
            future.append(bool(env.faults.any() or env.durable))
            obs, done = nxt, term or trunc
    return tuple(torch.as_tensor(np.asarray(rows)) for rows in (histories,actions,faults,problems,future))


def loss(logits, action, faults, problem, future):
    binary = torch.column_stack((faults,problem,future)).float()
    return nn.functional.cross_entropy(logits[:, :5],action) + nn.functional.binary_cross_entropy_with_logits(logits[:, 5:],binary)


def atomic_save(payload, path):
    temp = path.with_suffix(".tmp")
    torch.save(payload,temp)
    temp.replace(path)


def train(out, epochs, resume):
    train_set = dataset(TRAIN_START, 2200)
    valid = dataset(VALID_START, 400, "novel")
    print({"training_decisions":len(train_set[0]),"validation_decisions":len(valid[0])}, flush=True)
    for name in ("mlp","gru","lstm"):
        torch.manual_seed(4601)
        net = Specialist(name)
        optimizer = torch.optim.AdamW(net.parameters(), lr=.002)
        path = out/(name+".pt")
        first = 0
        if resume and path.exists():
            state = torch.load(path,weights_only=True)
            net.load_state_dict(state["weights"])
            optimizer.load_state_dict(state["optimizer"])
            first = state["epochs"]
            torch.set_rng_state(state["rng"])
        for epoch in range(first, epochs):
            net.train()
            for indices in torch.randperm(len(train_set[0])).split(192):
                history, *target = (array[indices] for array in train_set)
                objective = loss(net(history), *target)
                optimizer.zero_grad()
                objective.backward()
                optimizer.step()
            atomic_save({"architecture":name,"weights":net.state_dict(),"optimizer":optimizer.state_dict(),
                         "epochs":epoch+1,"rng":torch.get_rng_state()},path)
        net.eval()
        with torch.no_grad():
            logits = net(valid[0])
            action_temp = min((.7,1.,1.3,1.6,2.), key=lambda t:
                              nn.functional.cross_entropy(logits[:,:5]/t,valid[1]).item())
            state_temp = min((.7,1.,1.3,1.6,2.), key=lambda t:
                             nn.functional.binary_cross_entropy_with_logits(logits[:,9]/t,valid[3].float()).item())
            probs = torch.sigmoid(logits[:,9]/state_temp)
            def risk(cut):
                on = probs>=cut
                return int(((~on)&valid[3]).sum())*10 + int((on&~valid[3]).sum())
            cutoff = min((.15,.25,.35,.45,.55), key=risk)
            path_state = torch.load(path,weights_only=True)
            path_state.update(action_temp=action_temp,state_temp=state_temp,cutoff=cutoff,
                              validation_loss=float(loss(logits,*valid[1:])),
                              validation_risk=risk(cutoff),validation_accuracy=float((logits[:,:5].argmax(1)==valid[1]).float().mean()))
            atomic_save(path_state,path)
            print(name,{k:path_state[k] for k in ("epochs","validation_loss","validation_risk","validation_accuracy","action_temp","state_temp","cutoff")},flush=True)


def load(path):
    state = torch.load(path,weights_only=True)
    net = Specialist(state["architecture"])
    net.load_state_dict(state["weights"])
    return net.eval(), state


def decision(bundle, obs):
    net, state = bundle
    with torch.inference_mode():
        logits = net(torch.from_numpy(obs[None]))[0]
        action = int(logits[:5].argmax())
        confidence = float((logits[:5]/state["action_temp"]).softmax(0).max())
        diagnosis = (logits[5:9]>0).numpy()
        risk = float((logits[9]/state["state_temp"]).sigmoid())
        forecast = float(logits[10].sigmoid())
        return action, diagnosis, risk>=state["cutoff"], confidence, forecast, risk


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--epochs",type=int,default=10)
    parser.add_argument("--resume",action="store_true")
    args=parser.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    train(args.out,args.epochs,args.resume)
