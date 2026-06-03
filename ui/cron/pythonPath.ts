import path from 'path';
import fs from 'fs';
import { TOOLKIT_ROOT } from './paths';

const isWindows = process.platform === 'win32';

const pythonExe = isWindows ? 'python.exe' : 'python';
const activeEnvName = process.env.CONDA_DEFAULT_ENV || process.env.MAMBA_DEFAULT_ENV || '';

function addIfPresent(candidates: string[], candidate?: string | null) {
  if (candidate && candidate.trim() !== '') {
    candidates.push(candidate);
  }
}

// Shared resolver used by both the cron worker and Next.js API routes
// so the Python interpreter is configured in exactly one place.
export const resolvePythonPath = (): string => {
  const candidates: string[] = [];

  addIfPresent(candidates, process.env.AITK_PYTHON);

  if (activeEnvName === 'ai-toolkit') {
    if (process.env.CONDA_PREFIX) {
      candidates.push(path.join(process.env.CONDA_PREFIX, isWindows ? 'Scripts' : 'bin', pythonExe));
    }
  }

  if (process.env.MAMBA_ROOT_PREFIX) {
    candidates.push(path.join(process.env.MAMBA_ROOT_PREFIX, 'envs', 'ai-toolkit', isWindows ? 'Scripts' : 'bin', pythonExe));
  }

  if (isWindows) {
    candidates.push(path.join(TOOLKIT_ROOT, '.venv', 'Scripts', 'python.exe'));
    candidates.push(path.join(TOOLKIT_ROOT, 'venv', 'Scripts', 'python.exe'));
  } else {
    candidates.push(path.join(TOOLKIT_ROOT, '.venv', 'bin', 'python'));
    candidates.push(path.join(TOOLKIT_ROOT, 'venv', 'bin', 'python'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return isWindows ? 'python.exe' : 'python3';
};
