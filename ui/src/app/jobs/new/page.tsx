'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { defaultJobConfig, defaultDatasetConfig, migrateJobConfig } from './jobConfig';
import { jobTypeOptions } from './options';
import { JobConfig, SelectOption } from '@/types';
import { objectCopy } from '@/utils/basic';
import { useNestedState, setNestedValue } from '@/utils/hooks';
import { SelectInput } from '@/components/formInputs';
import useSettings from '@/hooks/useSettings';
import useGPUInfo from '@/hooks/useGPUInfo';
import useDatasetList from '@/hooks/useDatasetList';
import YAML from 'yaml';
import path from 'path';
import { TopBar, MainContent } from '@/components/layout';
import { Button } from '@headlessui/react';
import { FaChevronLeft } from 'react-icons/fa';
import SimpleJob from './SimpleJob';
import AdvancedConfigEditor from '@/components/AdvancedConfigEditor';
import ErrorBoundary from '@/components/ErrorBoundary';
import { apiClient } from '@/utils/api';

const isDev = process.env.NODE_ENV === 'development';

type CheckpointFile = {
  path: string;
  size: number;
  createdAtMs?: number;
};

const basename = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;

const isCheckpointFile = (file: CheckpointFile) => file.path.endsWith('.safetensors');

const isPrimaryCheckpointFile = (file: CheckpointFile, jobName: string | null) => {
  if (!isCheckpointFile(file)) return false;
  if (!jobName) return true;
  const name = basename(file.path);
  if (name.startsWith('CRITIC_')) return false;
  if (name.includes('_refiner')) return false;
  if (name.includes('_t2i')) return false;
  if (name.includes('_cn')) return false;
  if (name.includes('_clip')) return false;
  if (name.includes('_ip')) return false;
  if (name.includes('_adapter')) return false;
  return name === `${jobName}.safetensors` || name.startsWith(`${jobName}_`) || name.startsWith(`${jobName}_LoRA`);
};

const clearResumeFields = (config: JobConfig) => {
  const process = config.config.process[0] as any;
  delete process.resume_from_path;
  delete process.resume_from_name;
  delete process.resume_branch_from;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

export default function TrainingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const runId = searchParams.get('id');
  const cloneId = searchParams.get('cloneId');
  const [gpuIDs, setGpuIDs] = useState<string | null>(null);
  const [sourceJobName, setSourceJobName] = useState<string | null>(null);
  const [resumeFiles, setResumeFiles] = useState<CheckpointFile[]>([]);
  const [selectedResumePath, setSelectedResumePath] = useState('');
  const [resumeBranchName, setResumeBranchName] = useState('');
  const { settings, isSettingsLoaded } = useSettings();
  const { gpuList, isGPUInfoLoaded } = useGPUInfo();
  const { datasets, status: datasetFetchStatus } = useDatasetList();
  const [datasetOptions, setDatasetOptions] = useState<{ value: string; label: string }[]>([]);
  const [showAdvancedView, setShowAdvancedView] = useState(false);

  const [jobConfig, setJobConfig] = useNestedState<JobConfig>(objectCopy(migrateJobConfig(defaultJobConfig)));
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const checkpointFiles = resumeFiles.filter(file => isPrimaryCheckpointFile(file, sourceJobName));
  const latestResumePath = checkpointFiles.length > 0 ? checkpointFiles[checkpointFiles.length - 1].path : '';
  const isBranchResume = !!runId && !!selectedResumePath && selectedResumePath !== latestResumePath;
  const resumeCheckpointOptions: SelectOption[] = checkpointFiles.map(file => {
    const isLatest = file.path === latestResumePath;
    const size = formatBytes(file.size);
    return {
      value: file.path,
      label: `${basename(file.path)}${isLatest ? ' (latest)' : ''}${size ? ` - ${size}` : ''}`,
    };
  });

  const handleImportConfig = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        let parsed: any;
        if (file.name.endsWith('.json') || file.name.endsWith('.jsonc')) {
          parsed = JSON.parse(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
        } else {
          parsed = YAML.parse(text);
        }

        // Set required fields (same pattern as AdvancedJob.handleChange)
        try {
          parsed.config.process[0].sqlite_db_path = './aitk_db.db';
          parsed.config.process[0].training_folder = settings.TRAINING_FOLDER;
          parsed.config.process[0].device = 'cuda';
          parsed.config.process[0].performance_log_every = 10;
        } catch (err) {
          console.warn('Could not set required fields on imported config:', err);
        }

        migrateJobConfig(parsed);
        setJobConfig(parsed);
      } catch (err) {
        console.error('Failed to parse config file:', err);
        alert('Failed to parse config file. Please check the file format.');
      }
    };
    reader.readAsText(file);

    // Reset so the same file can be re-imported
    e.target.value = '';
  };

  useEffect(() => {
    if (!isSettingsLoaded) return;
    if (datasetFetchStatus !== 'success') return;

    const datasetOptions = datasets.map(name => ({ value: path.join(settings.DATASETS_FOLDER, name), label: name }));
    setDatasetOptions(datasetOptions);

    if (datasetOptions.length > 0) {
      const defaultDatasetPath = defaultDatasetConfig.folder_path;
      // Use functional updater so we check the *current* state, not a stale closure
      setJobConfig((prev: JobConfig) => {
        let updated = prev;
        for (let i = 0; i < prev.config.process[0].datasets.length; i++) {
          if (prev.config.process[0].datasets[i].folder_path === defaultDatasetPath) {
            updated = setNestedValue(updated, datasetOptions[0].value, `config.process[0].datasets[${i}].folder_path`);
          }
        }
        return updated;
      });
    }
  }, [datasets, settings, isSettingsLoaded, datasetFetchStatus]);

  // clone existing job
  useEffect(() => {
    if (cloneId) {
      apiClient
        .get(`/api/jobs?id=${cloneId}`)
        .then(res => res.data)
        .then(data => {
          console.log('Clone Training:', data);
          setSourceJobName(data.name);
          setGpuIDs(data.gpu_ids);
          const newJobConfig = migrateJobConfig(JSON.parse(data.job_config));
          newJobConfig.config.name = `${newJobConfig.config.name}_copy`;
          setJobConfig(newJobConfig);
        })
        .catch(error => console.error('Error fetching training:', error));
    }
  }, [cloneId]);

  useEffect(() => {
    if (runId) {
      apiClient
        .get(`/api/jobs?id=${runId}`)
        .then(res => res.data)
        .then(data => {
          console.log('Training:', data);
          setSourceJobName(data.name);
          setGpuIDs(data.gpu_ids);
          setJobConfig(migrateJobConfig(JSON.parse(data.job_config)));
        })
        .catch(error => console.error('Error fetching training:', error));
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      setResumeFiles([]);
      setSelectedResumePath('');
      setResumeBranchName('');
      return;
    }

    apiClient
      .get(`/api/jobs/${runId}/files`)
      .then(res => res.data)
      .then(data => {
        const files = Array.isArray(data.files) ? data.files.filter(isCheckpointFile) : [];
        files.sort((a: CheckpointFile, b: CheckpointFile) => {
          const createdCompare = (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
          return createdCompare !== 0 ? createdCompare : a.path.localeCompare(b.path);
        });
        setResumeFiles(files);
        if (files.length > 0) {
          setSelectedResumePath(files[files.length - 1].path);
        }
      })
      .catch(error => console.error('Error fetching checkpoint files:', error));
  }, [runId]);

  useEffect(() => {
    if (!runId || checkpointFiles.length === 0) return;
    const selectedIsValid = checkpointFiles.some(file => file.path === selectedResumePath);
    if (!selectedResumePath || !selectedIsValid) {
      setSelectedResumePath(latestResumePath);
    }
  }, [runId, sourceJobName, resumeFiles, selectedResumePath, latestResumePath]);

  useEffect(() => {
    if (isGPUInfoLoaded) {
      if (gpuIDs === null && gpuList.length > 0) {
        setGpuIDs(`${gpuList[0].index}`);
      }
    }
  }, [gpuList, isGPUInfoLoaded]);

  useEffect(() => {
    if (isSettingsLoaded) {
      setJobConfig(settings.TRAINING_FOLDER, 'config.process[0].training_folder');
    }
  }, [settings, isSettingsLoaded]);

  const saveJob = async () => {
    if (status === 'saving') return;

    const configToSave: JobConfig = objectCopy(jobConfig);
    const processConfig = configToSave.config.process[0] as any;
    const trimmedBranchName = resumeBranchName.trim();
    const creatingBranch = isBranchResume;

    if (creatingBranch) {
      if (!trimmedBranchName) {
        alert('Please enter a branch name before creating a branch from an older checkpoint.');
        return;
      }
      if (/[\\/]/.test(trimmedBranchName)) {
        alert('Branch name cannot contain slashes.');
        return;
      }
      if (trimmedBranchName === '.' || trimmedBranchName === '..') {
        alert('Branch name must be a normal folder name.');
        return;
      }
      if (trimmedBranchName === sourceJobName) {
        alert('Branch name must be different from the source job name.');
        return;
      }

      configToSave.config.name = trimmedBranchName;
      processConfig.resume_from_path = selectedResumePath;
      processConfig.resume_from_name = basename(selectedResumePath);
      processConfig.resume_branch_from = sourceJobName ?? jobConfig.config.name;
      delete processConfig.train.start_step;
    } else if (latestResumePath && selectedResumePath === latestResumePath) {
      clearResumeFields(configToSave);
    }

    setStatus('saving');

    apiClient
      .post('/api/jobs', {
        id: creatingBranch ? undefined : runId,
        name: configToSave.config.name,
        gpu_ids: gpuIDs,
        job_config: configToSave,
      })
      .then(res => {
        setStatus('success');
        if (runId && !creatingBranch) {
          router.push(`/jobs/${runId}`);
        } else {
          router.push(`/jobs/${res.data.id}`);
        }
      })
      .catch(error => {
        if (error.response?.status === 409) {
          alert('Training name already exists. Please choose a different name.');
        } else {
          alert('Failed to save job. Please try again.');
        }
        console.log('Error saving training:', error);
      })
      .finally(() =>
        setTimeout(() => {
          setStatus('idle');
        }, 2000),
      );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    saveJob();
  };

  return (
    <>
      <TopBar>
        <div className="flex-shrink-0">
          <Button className="text-gray-500 dark:text-gray-300 px-2 sm:px-3 mt-1" onClick={() => history.back()}>
            <FaChevronLeft />
          </Button>
        </div>
        <div className="flex-shrink-0">
          <h1 className="text-base sm:text-lg truncate max-w-[120px] sm:max-w-none">
            {runId ? 'Edit Training Job' : 'New Training Job'}
          </h1>
        </div>
        <div className="flex-1"></div>
        {showAdvancedView && (
          <>
            <div className="hidden sm:block">
              <SelectInput
                value={`${gpuIDs}`}
                onChange={value => setGpuIDs(value)}
                options={gpuList.map((gpu: any) => ({ value: `${gpu.index}`, label: `GPU #${gpu.index}` }))}
              />
            </div>
            <div className="hidden sm:block mx-4 bg-gray-200 dark:bg-gray-800 w-1 h-6"></div>
            <div className="hidden md:block">
              <Button className="text-gray-200 bg-gray-800 px-3 py-1 rounded-md" onClick={handleImportConfig}>
                Import Config
              </Button>
            </div>
            <div className="hidden md:block mx-4 bg-gray-200 dark:bg-gray-800 w-1 h-6"></div>
          </>
        )}
        {!showAdvancedView && (
          <>
            <div className="hidden sm:block">
              <SelectInput
                value={`${jobConfig?.config.process[0].type}`}
                onChange={value => {
                  // undo current job type changes
                  const currentOption = jobTypeOptions.find(
                    option => option.value === jobConfig?.config.process[0].type,
                  );
                  if (currentOption && currentOption.onDeactivate) {
                    setJobConfig(currentOption.onDeactivate(objectCopy(jobConfig)));
                  }
                  const option = jobTypeOptions.find(option => option.value === value);
                  if (option) {
                    if (option.onActivate) {
                      setJobConfig(option.onActivate(objectCopy(jobConfig)));
                    }
                    jobTypeOptions.forEach(opt => {
                      if (opt.value !== option.value && opt.onDeactivate) {
                        setJobConfig(opt.onDeactivate(objectCopy(jobConfig)));
                      }
                    });
                  }
                  setJobConfig(value, 'config.process[0].type');
                }}
                options={jobTypeOptions}
              />
            </div>
            <div className="hidden sm:block mx-4 bg-gray-200 dark:bg-gray-800 w-1 h-6"></div>
          </>
        )}

        <div className="pr-1 sm:pr-2 flex-shrink-0">
          <Button
            className="text-gray-200 bg-gray-800 px-2 sm:px-3 py-1 rounded-md text-xs sm:text-base"
            onClick={() => setShowAdvancedView(!showAdvancedView)}
          >
            <span className="sm:hidden">{showAdvancedView ? 'Simple' : 'Advanced'}</span>
            <span className="hidden sm:inline">{showAdvancedView ? 'Show Simple' : 'Show Advanced'}</span>
          </Button>
        </div>
        <div className="flex-shrink-0">
          <Button
            className="text-white bg-green-600 hover:bg-green-700 px-2 sm:px-3 py-1 rounded-md text-xs sm:text-base"
            onClick={() => saveJob()}
            disabled={status === 'saving'}
          >
            {status === 'saving' ? (
              'Saving...'
            ) : (
              <>
                <span className="sm:hidden">{isBranchResume ? 'Branch' : runId ? 'Update' : 'Create'}</span>
                <span className="hidden sm:inline">
                  {isBranchResume ? 'Create Branch' : runId ? 'Update Job' : 'Create Job'}
                </span>
              </>
            )}
          </Button>
        </div>
      </TopBar>

      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml,.json,.jsonc"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      {showAdvancedView ? (
        <div className="pt-[48px] absolute top-0 left-0 w-full h-full overflow-auto">
          <AdvancedConfigEditor
            config={jobConfig}
            setConfig={setJobConfig}
            transformOnParse={(parsed: any) => {
              try {
                parsed.config.process[0].sqlite_db_path = './aitk_db.db';
                parsed.config.process[0].training_folder = settings.TRAINING_FOLDER;
                parsed.config.process[0].device = 'cuda';
                parsed.config.process[0].performance_log_every = 10;
              } catch (e) {
                console.warn(e);
              }
              return migrateJobConfig(parsed);
            }}
          />
        </div>
      ) : (
        <MainContent>
          <ErrorBoundary
            fallback={
              <div className="flex items-center justify-center h-64 text-lg text-red-600 font-medium bg-red-100 dark:bg-red-900/20 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-lg">
                Advanced job detected. Please switch to advanced view to continue.
              </div>
            }
          >
            <SimpleJob
              jobConfig={jobConfig}
              setJobConfig={setJobConfig}
              status={status}
              handleSubmit={handleSubmit}
              runId={runId}
              resumeCheckpointOptions={resumeCheckpointOptions}
              selectedResumePath={selectedResumePath}
              setSelectedResumePath={setSelectedResumePath}
              resumeBranchName={resumeBranchName}
              setResumeBranchName={setResumeBranchName}
              isBranchResume={isBranchResume}
              gpuIDs={gpuIDs}
              setGpuIDs={setGpuIDs}
              gpuList={gpuList}
              datasetOptions={datasetOptions}
              isLoading={!isSettingsLoaded || !isGPUInfoLoaded || datasetFetchStatus !== 'success'}
            />
          </ErrorBoundary>

          <div className="pt-20"></div>
        </MainContent>
      )}
    </>
  );
}
