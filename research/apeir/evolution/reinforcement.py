"""CPU PPO and DQN with stage-level restart and checked transition semantics."""
import argparse
import json
import io
from zipfile import ZIP_DEFLATED, ZipFile
from pathlib import Path

import numpy as np
import torch
from stable_baselines3 import DQN, PPO
from stable_baselines3.common.env_checker import check_env

from world import ApeirWorld, VALID_START, permitted

torch.set_num_threads(1)
ALGORITHMS = {"ppo":PPO,"dqn":DQN}


def validation(model, episodes=160):
    outcomes = []
    for seed in range(VALID_START+3000,VALID_START+3000+episodes):
        env = ApeirWorld(distribution="novel")
        obs,_ = env.reset(seed=seed)
        reward = 0
        while True:
            action = rl_action(model,obs)
            obs,r,end,truncated,info = env.step(action)
            reward += r
            if end or truncated:
                outcomes.append(reward)
                break
    return float(np.mean(outcomes))


def save_resume(model, path):
    snapshot = path.with_suffix(".tmp")
    model_bytes = io.BytesIO()
    model.save(model_bytes)
    with ZipFile(snapshot,"w",compression=ZIP_DEFLATED) as archive:
        archive.writestr("model.zip",model_bytes.getvalue())
        if isinstance(model,DQN):
            replay = io.BytesIO()
            model.save_replay_buffer(replay)
            archive.writestr("replay.pkl",replay.getvalue())
    snapshot.replace(path)


def load_resume(cls, path):
    with ZipFile(path) as archive:
        model = cls.load(io.BytesIO(archive.read("model.zip")),env=ApeirWorld(),device="cpu")
        if cls is DQN:
            model.load_replay_buffer(io.BytesIO(archive.read("replay.pkl")))
    return model


def train(out, algo, steps, resume):
    cls = ALGORITHMS[algo]
    prior = out/(algo+"-latest.zip")
    resume_path = out/(algo+"-resume.zip")
    if resume and resume_path.exists():
        model = load_resume(cls,resume_path)
        model.save(prior)
    else:
        knobs = {"n_steps":256,"batch_size":64,"n_epochs":4} if algo=="ppo" else {
            "buffer_size":20000,"learning_starts":256,"batch_size":64,"train_freq":4,"target_update_interval":512,
            "exploration_fraction":.30,"exploration_final_eps":.05}
        model = cls("MlpPolicy",ApeirWorld(level=0),policy_kwargs={"net_arch":[64,32]},
                    seed=4703,device="cpu",learning_rate=.0007,gamma=.97,**knobs)
    # SB3 PPO batches are 256 steps, so use a divisible budget.
    stage=max(256,(steps//3//256)*256)
    for level in range(3):
        cumulative = (level+1)*stage
        remaining = cumulative-model.num_timesteps
        if remaining<=0:
            continue
        env=ApeirWorld(level=level)
        model.set_env(env)
        model.get_env().seed(4703+level)
        model.learn(total_timesteps=remaining,reset_num_timesteps=False)
        checkpoint = out/f"{algo}-{model.num_timesteps}"
        model.save(checkpoint)
        save_resume(model,resume_path)
        model.save(prior)
        print(algo,level,model.num_timesteps,flush=True)
    score=validation(model)
    (out/(algo+".json")).write_text(json.dumps({"steps":model.num_timesteps,"validation_return":score},indent=2)+"\n")
    print(algo,"validation return",score,flush=True)


def rl_action(model, obs):
    """Mask disallowed actions before proposing one. Environment checks again."""
    mask = permitted(obs)
    with torch.inference_mode():
        tensor = model.policy.obs_to_tensor(obs)[0]
        if isinstance(model,DQN):
            scores=model.q_net(tensor)[0].cpu().numpy()
        else:
            scores=model.policy.get_distribution(tensor).distribution.logits[0].cpu().numpy()
    return int(np.where(mask,scores,-np.inf).argmax())


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--algo",choices=ALGORITHMS,required=True)
    p.add_argument("--steps",type=int,default=24576)
    p.add_argument("--resume",action="store_true")
    a=p.parse_args()
    a.out.mkdir(exist_ok=True,parents=True)
    check_env(ApeirWorld(),warn=False)
    train(a.out,a.algo,a.steps,a.resume)
