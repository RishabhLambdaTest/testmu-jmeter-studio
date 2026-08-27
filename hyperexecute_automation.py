#!/usr/bin/env python3

"""
HyperExecute JMeter End-to-End Automation Script

Automates the COMPLETE workflow:
1. Create a HyperExecute project (jmeter type)         <-- NEW
2. Upload files (.jmx + optional data/property files)  <-- NEW
3. Trigger a JMeter job
4. Monitor job status until completion
5. Monitor artifact status until completion
6. Download artifacts as a zip file

Every parameter (credentials, project name, files, test config) is supplied
dynamically via CLI flags or environment variables. If --project-id is given,
the create/upload steps are skipped and the job is triggered on the existing
project (backwards compatible with the previous version of this script).
"""

import requests
import time
import json
import sys
import os
import base64
from typing import Dict, Any, Optional, List
import argparse

# ---------------------------------------------------------------------- #
# Small helpers for clean, readable terminal output                      #
# ---------------------------------------------------------------------- #
_WIDTH = 62


def ui_header(title: str) -> None:
    """Print a titled section header."""
    print()
    print("=" * _WIDTH)
    print(f"  {title}")
    print("=" * _WIDTH)


def ui_field(label: str, value: Any) -> None:
    """Print an aligned 'label : value' line."""
    print(f"  {label:<14}{value}")


def ui_step(message: str) -> None:
    """Print a step / progress line."""
    print(f"  -> {message}")


def ui_ok(message: str) -> None:
    """Print a success line."""
    print(f"  [OK] {message}")


def ui_error(message: str) -> None:
    """Print an error line."""
    print(f"  [ERROR] {message}")


def _mask(secret: str) -> str:
    """Show enough of a key to spot a paste error, never enough to leak it."""
    secret = secret or ""
    if not secret:
        return "(empty)"
    return f"{secret[:4]}...{secret[-2:]} ({len(secret)} chars)"


class HyperExecuteAPI:
    """Class to handle HyperExecute API operations"""

    def __init__(self, username: str, api_key: str,
                 project_id: Optional[str] = None, debug: bool = False):
        """
        Initialize the HyperExecute API client

        Args:
            username: LambdaTest username
            api_key: LambdaTest API key/access key
            project_id: Optional existing Project ID. If None, create_project() must
                        be called before triggering a job.
            debug: When True, print verbose HTTP details (URLs, payloads, raw
                   response bodies). When False, keep the output clean.
        """
        self.username = username
        self.api_key = api_key
        self.project_id = project_id
        self.debug = debug
        # Why the last create/upload/trigger failed. The callers return
        # None/False; the console needs the reason, not just the fact.
        self.last_error: Optional[str] = None

        # Generate Basic Auth token from username and API key
        credentials = f"{username}:{api_key}"
        self.auth_token = base64.b64encode(credentials.encode()).decode()

        # Host that serves project/upload/trigger (reception) APIs
        self.base_url_trigger = "https://api-hyperexecute.lambdatest.com"
        # Host that serves job/artifact status APIs
        self.base_url_status = "https://api.hyperexecute.cloud"

        self.headers = {
            'accept': 'application/json',
            'Authorization': f'Basic {self.auth_token}',
            'content-type': 'application/json'
        }

        # Common headers used for the reception-host (create/trigger) JSON calls
        self.reception_headers = {
            'accept': 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            'authorization': f'Basic {self.auth_token}',
            'content-type': 'application/json',
            'origin': 'https://hyperexecute.lambdatest.com',
            'referer': 'https://hyperexecute.lambdatest.com/hyperexecute/projects',
        }

        if self.debug:
            print(f"[DEBUG] API client ready for user: {username}")

    def _dbg(self, message: str) -> None:
        """Print a message only when debug mode is enabled."""
        if self.debug:
            print(message)

    def _fail(self, message: str):
        """Report a failure to the terminal and keep it for the caller."""
        self.last_error = message
        ui_error(message)
        return None

    def _http_error(self, action: str, status: int, body: str) -> str:
        """Turn an HTTP failure into something the reader can act on.

        A 401 here is always the same story - HyperExecute answers
        '1002 - Invalid Authentication Token' whatever is wrong with the
        credentials - so the message has to supply the part it withholds.
        """
        body = (body or "").strip()[:300]
        if status in (401, 403):
            return (
                "HyperExecute rejected the credentials (HTTP %d).\n"
                "        Username must be the LambdaTest username, not the email "
                "you sign in with.\n"
                "        Both are on accounts.lambdatest.com/detail/profile - "
                "'Username' and 'Access Key'.\n"
                "        Sent username: %s | key: %s"
                % (status, self.username or "(empty)", _mask(self.api_key)))
        if status == 404:
            return ("%s: HTTP 404 - the endpoint was not found. %s" % (action, body))
        if status >= 500:
            return ("%s: HyperExecute returned HTTP %d - a server-side error, "
                    "worth retrying. %s" % (action, status, body))
        return "%s: HTTP %d %s" % (action, status, body)

    # ------------------------------------------------------------------ #
    # Step 1: Create project                                             #
    # ------------------------------------------------------------------ #
    def create_project(self, name: str, project_type: str = "jmeter") -> Optional[str]:
        """
        Create a new HyperExecute project.

        Args:
            name: Project name (shown in the HyperExecute dashboard)
            project_type: Project type (default: "jmeter")

        Returns:
            The created project ID if successful, else None. On success the
            project_id is also stored on the instance for later steps.
        """
        url = f"{self.base_url_trigger}/logistics/v1.0/project"
        payload = {"name": name, "jmx": [], "type": project_type}

        try:
            ui_step(f"Creating project '{name}' ({project_type}) ...")
            self._dbg(f"[DEBUG] POST {url}")

            response = requests.post(url, headers=self.reception_headers,
                                     json=payload, timeout=30)
            self._dbg(f"[DEBUG] {response.status_code} {response.text[:300]}")

            # Try to read the response body as JSON for friendly handling.
            try:
                result = response.json()
            except ValueError:
                result = {}

            # Friendly handling: the project name is already taken.
            error_message = str((result.get('error') or {}).get('message', '')).lower()
            if 'already exists' in error_message or response.status_code == 409:
                print()
                self.last_error = (
                    f"a project named '{name}' already exists - open it on the "
                    f"Projects dashboard and paste its ID into Project ID, or "
                    f"pick a different name")
                ui_error(f"A project named '{name}' already exists in your account.")
                print("        You do not need to create it again - run a test with:")
                print("          python3 hyperexecute_automation.py trigger \\")
                print("            --userName <u> --accessKey <k> \\")
                print("            --project-id <its ID> --jmx-path <your.jmx>")
                print("        (Find the ID on the HyperExecute Projects dashboard, or")
                print("         use a different --project-name to create a new project.)")
                return None

            # Any other non-success HTTP status: show a concise reason.
            if not response.ok:
                reason = ((result.get('error') or {}).get('message')
                          or result.get('message') or response.text)
                return self._fail(self._http_error(
                    "could not create the project", response.status_code, reason))

            # The project id can come back under a few possible keys / nesting
            project_id = (
                result.get('id')
                or result.get('projectId')
                or result.get('projectID')
                or (result.get('data') or {}).get('id')
                or (result.get('data') or {}).get('projectId')
            )

            if not project_id:
                return self._fail(
                    f"project created but no ID came back in the response: {result}")

            self.project_id = project_id
            ui_ok(f"Project created  (ID: {project_id})")
            return project_id

        except requests.exceptions.RequestException as e:
            return self._fail(f"network error while creating the project: {e}")

    # ------------------------------------------------------------------ #
    # Step 2: Upload files                                               #
    # ------------------------------------------------------------------ #
    def upload_files(self, file_paths: List[str]) -> bool:
        """
        Upload one or more files (.jmx and any data/property files) to the
        current project.

        Args:
            file_paths: List of local file paths to upload.

        Returns:
            True if the upload succeeded, else False.
        """
        if not self.project_id:
            ui_error("No project_id set. Create a project first.")
            return False

        # Validate files exist up front
        missing = [p for p in file_paths if not os.path.isfile(p)]
        if missing:
            self._fail(f"these files do not exist: {missing}")
            return False

        url = f"{self.base_url_trigger}/logistics/v1.0/project/{self.project_id}/files/upload"

        # NOTE: Do NOT set content-type manually here - requests builds the
        # multipart/form-data boundary automatically when using `files=`.
        upload_headers = {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            'authorization': f'Basic {self.auth_token}',
            'origin': 'https://hyperexecute.lambdatest.com',
            'referer': 'https://hyperexecute.lambdatest.com/hyperexecute/projects',
        }

        open_files = []
        try:
            ui_step(f"Uploading {len(file_paths)} file(s):")
            for path in file_paths:
                print(f"       - {os.path.basename(path)}")

            # All files are sent under the same form field name "files"
            multipart = []
            for path in file_paths:
                fh = open(path, 'rb')
                open_files.append(fh)
                multipart.append(
                    ('files', (os.path.basename(path), fh, 'application/octet-stream'))
                )

            response = requests.post(url, headers=upload_headers,
                                     files=multipart, timeout=120)
            self._dbg(f"[DEBUG] {response.status_code} {response.text[:300]}")
            response.raise_for_status()

            ui_ok("Files uploaded")
            return True

        except requests.exceptions.RequestException as e:
            resp = getattr(e, 'response', None)
            if resp is not None:
                self._dbg(f"[DEBUG] {resp.text}")
                self._fail(self._http_error("upload failed", resp.status_code, resp.text))
            else:
                self._fail(f"upload failed: {e}")
            return False
        finally:
            for fh in open_files:
                fh.close()

    # ------------------------------------------------------------------ #
    # Step 3: Trigger job                                                #
    # ------------------------------------------------------------------ #
    @staticmethod
    def build_report_args(report_dir: str = "report",
                          extra_args: Optional[List[str]] = None) -> List[str]:
        """
        Build the JMeter CLI `args` array that controls report generation.

        The HyperExecute dashboard has no field for these, but the trigger API
        does accept them - so passing them here reaches something the UI cannot.
        `-J<property>=value` and `-D` overrides are still rejected by the API.
        Report tuning (title, percentiles, apdex, etc.) must therefore be set in
        user.properties, which is uploaded with the job.

        Always includes `-e -o <report_dir>` to generate the HTML dashboard
        (required for HyperExecute dashboard data).
        """
        args = ["-e", "-o", report_dir]

        # Any additional raw JMeter args passed straight through. Use with care:
        # the trigger API validates args and rejects unsupported flags (e.g. -J).
        if extra_args:
            args.extend(extra_args)

        return args

    def trigger_job(self, regions: List[str], jmx_path: str,
                    duration: Optional[int] = None, rampup: Optional[int] = None,
                    platform: Optional[str] = None,
                    vusers: Optional[int] = None,
                    max_vusers_per_vm: Optional[int] = None,
                    global_timeout: Optional[int] = None,
                    concurrency: int = 1, splitcsv: bool = False,
                    job_label: Optional[str] = None,
                    report_args: Optional[List[str]] = None,
                    report_dir: str = "report") -> Optional[str]:
        """
        Trigger a new JMeter job across one or more regions.

        Any of duration / rampup / max_vusers_per_vm / global_timeout that is
        None is OMITTED from the payload, so HyperExecute/JMeter falls back to
        the value baked into the uploaded .jmx (or the platform default). Only
        the values the customer explicitly passes at runtime are sent.

        Args:
            regions: One or more regions to run in (each becomes a `jmeter`
                     entry), e.g. ["westus", "eastus", "centralindia"]. A region
                     may carry its own platform as "region:platform"
                     (e.g. "westus:azure"); regions without one, and with no
                     global `platform`, are sent WITHOUT a platform field.
            jmx_path: Name of the uploaded .jmx as HyperExecute expects it in the
                      trigger payload (e.g. "loadtesting.jmx").
            duration: Test duration seconds per region. None -> use jmx value.
            vusers: Total virtual users per region - the dashboard's "max users".
                    Overrides the thread count in the .jmx. Engines are allocated
                    as ceil(vusers / max_vusers_per_vm), default 2000 per engine.
            rampup: Ramp-up seconds per region. None -> use jmx value.
            platform: Optional default cloud platform applied to regions that do
                      not specify their own. If None, no platform field is sent.
            max_vusers_per_vm: The dashboard's "max users per engine" - the cap that
                    decides how many engines a run is spread over. None -> omit,
                    and HyperExecute's own default (2000) applies.
            global_timeout: Overall job timeout in minutes. None -> omit.
            concurrency: Job concurrency level.
            splitcsv: Whether to split CSV files across nodes.
            job_label: Optional dashboard label. If None/empty, jobLabel is sent
                       as an empty list (label is NOT mandatory).
            report_args: JMeter `args` array controlling report generation. If
                         None, a default `-e -o <report_dir>` is used.
            report_dir: HTML report output directory (also collected as artifact).

        Returns:
            Job ID if successful, None otherwise.
        """
        if not self.project_id:
            ui_error("No project_id set. Create a project first.")
            return None

        if not regions:
            ui_error("At least one region is required to trigger a job.")
            return None

        url = f"{self.base_url_trigger}/reception/api/project/{self.project_id}/trigger-job"

        if report_args is None:
            report_args = self.build_report_args(report_dir=report_dir)

        # One jmeter entry per region. A region may be "name" or "name:platform".
        # Only include duration/rampup/platform when they are actually provided -
        # otherwise the .jmx's own settings apply.
        jmeter_entries = []
        for region in regions:
            if ':' in region:
                region_name, region_platform = region.split(':', 1)
            else:
                region_name, region_platform = region, platform

            entry = {
                "region": region_name,
                "splitcsv": splitcsv,
                # Report generation args (runtime-configurable)
                "args": report_args,
                "jmx": jmx_path,
            }
            if duration is not None:
                entry["duration"] = duration
            if rampup is not None:
                entry["rampup"] = rampup
            if vusers is not None:
                # the dashboard calls this "max users" - the total VU for the
                # region. HyperExecute derives the engine count from it and
                # max_vusers_per_vm; there is no machine-count field.
                # The wire key is "users": the job YAML echoes it back under
                # performance.jmeter[].users, and an unknown key is dropped
                # silently, which reads as "the run ignored my user count".
                entry["users"] = vusers
            if region_platform:
                entry["platform"] = region_platform
            jmeter_entries.append(entry)

        # jobLabel is optional: send [label] only when provided, else [].
        job_label_field = [job_label] if job_label else []

        payload = {
            "jmeter": jmeter_entries,
            "jobLabel": job_label_field,
            "concurrency": concurrency,
            # HyperExecute already auto-generates a default "JMeter" artifact
            # containing the run logs (errors.xml, jmeter.log, results.jtl), so
            # we only define the HTML "report" artifact here. Defining our own
            # "JMeter" too would create a duplicate same-named artifact.
            "uploadArtefacts": [
                {
                    "name": "report",
                    "path": [
                        f"{report_dir}/**/*",
                    ]
                }
            ]
        }

        # Only send these HyperExecute-level knobs when the customer set them.
        if max_vusers_per_vm is not None:
            payload["max_vusers_per_vm"] = max_vusers_per_vm
        if global_timeout is not None:
            payload["globalTimeout"] = global_timeout

        try:
            ui_step(f"Triggering job in {len(regions)} region(s): {', '.join(regions)}")
            self._dbg(f"[DEBUG] POST {url}")
            self._dbg(f"[DEBUG] Payload: {json.dumps(payload, indent=2)}")

            response = requests.post(url, headers=self.reception_headers,
                                     json=payload, timeout=30)
            self._dbg(f"[DEBUG] {response.status_code} {response.text[:300]}")
            response.raise_for_status()

            result = response.json()
            job_id = result.get('jobId') or result.get('jobID')

            if result.get('status') == 'success' and job_id:
                ui_ok(f"Job triggered  (Job ID: {job_id})")
                return job_id
            else:
                return self._fail(f"the trigger was rejected: {result}")

        except requests.exceptions.RequestException as e:
            resp = getattr(e, 'response', None)
            if resp is not None:
                self._dbg(f"[DEBUG] {resp.status_code} {resp.text}")
                return self._fail(self._http_error(
                    "the trigger failed", resp.status_code, resp.text))
            return self._fail(f"the trigger failed: {e}")

    # ------------------------------------------------------------------ #
    # Step 4: Monitor job status                                         #
    # ------------------------------------------------------------------ #
    def check_job_status(self, job_id: str, poll_interval: int = 10,
                         max_wait_time: int = 3600) -> bool:
        """Monitor job status until completion. Returns True on success."""
        url = f"{self.base_url_status}/v2.0/job/{job_id}"
        ui_step(f"Waiting for job to finish (polling every {poll_interval}s) ...")

        start_time = time.time()
        last_status = None

        while True:
            try:
                response = requests.get(url, headers=self.headers, timeout=30)
                response.raise_for_status()

                result = response.json()
                data = result.get('data', {})
                status = data.get('status')
                elapsed_time = int(time.time() - start_time)

                # Only print when the status actually changes - keeps it clean.
                if status != last_status:
                    print(f"       [{elapsed_time:>4}s] {status}")
                    last_status = status

                if status == 'completed':
                    ui_ok("Job completed")
                    self._display_job_summary(data, result)
                    return True
                if status in ['failed', 'cancelled', 'aborted', 'timeout']:
                    ui_error(f"Job ended with status: {status}")
                    self._display_job_summary(data, result)
                    return False

                if elapsed_time > max_wait_time:
                    ui_error(f"Timeout: job did not complete within {max_wait_time}s")
                    return False

                time.sleep(poll_interval)

            except requests.exceptions.RequestException as e:
                ui_error(f"Error checking job status: {e}")
                return False

    def _display_job_summary(self, data: Dict[str, Any], result: Dict[str, Any]) -> None:
        """Helper method to display a compact job summary."""
        task_count = data.get('taskCount', {})
        print()
        ui_field("Job Number", data.get('jobNumber'))
        ui_field("Tasks", f"{task_count.get('completed', 0)} completed / "
                          f"{task_count.get('failed', 0)} failed / "
                          f"{task_count.get('total', 0)} total")
        ui_field("Exec Time", result.get('executionTime', 'N/A'))

    # ------------------------------------------------------------------ #
    # Step 5: Monitor artifact status                                    #
    # ------------------------------------------------------------------ #
    def check_artifact_status(self, job_id: str, poll_interval: int = 10,
                              max_wait_time: int = 600) -> bool:
        """Monitor artifact status until completion. Returns True when ready."""
        url = f"{self.base_url_status}/v2.0/job/{job_id}/artefacts"
        ui_step(f"Waiting for artifacts (polling every {poll_interval}s) ...")

        start_time = time.time()
        while True:
            try:
                response = requests.get(url, headers=self.headers)
                response.raise_for_status()

                result = response.json()
                artifacts = result.get('data', [])
                elapsed_time = int(time.time() - start_time)

                if artifacts:
                    all_completed = all(a.get('status') == 'completed' for a in artifacts)
                    self._dbg("[DEBUG] " + ", ".join(
                        f"{a.get('name')}={a.get('status')}" for a in artifacts))

                    if all_completed:
                        ui_ok("Artifacts ready")
                        for artifact in artifacts:
                            size = artifact.get('size') or 0
                            ui_field(artifact.get('name', 'artifact'),
                                     f"{size} bytes")
                        return True

                if elapsed_time > max_wait_time:
                    ui_error(f"Timeout: artifacts not ready within {max_wait_time}s")
                    return False

                time.sleep(poll_interval)

            except requests.exceptions.RequestException as e:
                ui_error(f"Error checking artifact status: {e}")
                return False

    # ------------------------------------------------------------------ #
    # Step 6: Download artifacts                                         #
    # ------------------------------------------------------------------ #
    def download_artifact(self, job_id: str, artifact_name: str = "JMeter",
                          output_filename: Optional[str] = None) -> bool:
        """Download artifacts as a zip file. Returns True on success."""
        url = f"{self.base_url_status}/v2.0/artefacts/{job_id}/download?name={artifact_name}"
        if output_filename is None:
            output_filename = f"{job_id}_{artifact_name}.zip"

        try:
            ui_step(f"Downloading artifact '{artifact_name}' ...")
            response = requests.get(url, headers=self.headers, stream=True)
            response.raise_for_status()

            with open(output_filename, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            file_size = os.path.getsize(output_filename)
            ui_ok(f"Downloaded {output_filename} ({file_size / 1024:.1f} KB)")
            return True

        except requests.exceptions.RequestException as e:
            ui_error(f"Error downloading artifact: {e}")
            if getattr(getattr(e, 'response', None), 'text', None) is not None:
                self._dbg(f"[DEBUG] {e.response.text}")
            return False


def _add_credentials_args(p: argparse.ArgumentParser) -> None:
    """Credential + debug args, shared by both subcommands."""
    p.add_argument('--userName', type=str, default=None,
                   help='LambdaTest username (or LAMBDATEST_USERNAME env var)')
    p.add_argument('--accessKey', type=str, default=None,
                   help='LambdaTest access key (or LAMBDATEST_ACCESS_KEY env var)')
    p.add_argument('--debug', action='store_true', help='Verbose debug output')


def _add_run_args(p: argparse.ArgumentParser) -> None:
    """
    Test-run args - used by the 'trigger' command only (these are the values
    you tune frequently between runs).
    """
    # Regions / infrastructure
    p.add_argument('--regions', type=str, nargs='+', default=['eastus'],
                   help='One or more regions to run in (space-separated). Each '
                        'becomes a jmeter entry. A region may carry its own '
                        'platform as "region:platform" (e.g. westus:azure). '
                        'Default: eastus')
    p.add_argument('--platform', type=str, default=None,
                   help='Optional default cloud platform for regions that do not '
                        'specify their own (e.g. azure). If omitted, no platform '
                        'field is sent.')
    p.add_argument('--vusers', type=int, default=None,
                   help='Max users (total virtual users) per region. If omitted, '
                        'the thread count in the .jmx applies.')
    p.add_argument('--max-vusers-per-vm', type=int, default=None,
                   help='Max virtual users per VM. If omitted, not sent (uses '
                        'the HyperExecute default).')
    p.add_argument('--global-timeout', type=int, default=None,
                   help='Overall job timeout in minutes. If omitted, not sent '
                        '(uses the HyperExecute default).')

    # Load profile - if omitted, the value from the uploaded .jmx is used.
    p.add_argument('--duration', type=int, default=None,
                   help='Duration seconds per region. If omitted, the value in '
                        'the .jmx is used.')
    p.add_argument('--rampup', type=int, default=None,
                   help='Ramp-up seconds per region. If omitted, the value in '
                        'the .jmx is used.')
    p.add_argument('--concurrency', type=int, default=1, help='Concurrency (default: 1)')
    p.add_argument('--splitcsv', action='store_true', help='Split CSV files across nodes')
    p.add_argument('--job-label', type=str, default=None,
                   help='Optional job label for the dashboard. Not mandatory - '
                        'if omitted, no label is sent (jobLabel is empty).')

    # Reporting config (goes into the trigger-job payload "args")
    p.add_argument('--report-dir', type=str, default='report',
                   help='HTML report output directory (default: report)')
    p.add_argument('--extra-jmeter-args', type=str, nargs='+', default=None,
                   help='Extra raw JMeter args appended after "-e -o <report-dir>". '
                        'Note: the trigger API only allows a limited arg set '
                        '(-J property overrides are rejected).')

    # Polling / output
    p.add_argument('--job-poll-interval', type=int, default=10,
                   help='Job status poll interval seconds (default: 10)')
    p.add_argument('--artifact-poll-interval', type=int, default=10,
                   help='Artifact status poll interval seconds (default: 10)')
    p.add_argument('--output', type=str, default=None,
                   help='Output zip filename (default: auto-generated)')
    p.add_argument('--no-download', action='store_true',
                   help='Skip artifact download (job completion only)')


def _resolve_credentials(args) -> tuple:
    """Resolve username/access key from args or environment."""
    username = args.userName or os.environ.get('LAMBDATEST_USERNAME')
    api_key = args.accessKey or os.environ.get('LAMBDATEST_ACCESS_KEY')
    if not username:
        ui_error("Username required (--userName or LAMBDATEST_USERNAME)")
        sys.exit(1)
    if not api_key:
        ui_error("Access key required (--accessKey or LAMBDATEST_ACCESS_KEY)")
        sys.exit(1)
    return username, api_key


def _run_test(api: 'HyperExecuteAPI', args, jmx_path: str) -> None:
    """
    Shared execution: trigger -> monitor job -> monitor artifacts -> download.
    Assumes api.project_id is already set. Exits(1) on any failure.
    """
    report_args = HyperExecuteAPI.build_report_args(
        report_dir=args.report_dir,
        extra_args=args.extra_jmeter_args,
    )

    # Trigger the job
    job_id = api.trigger_job(
        regions=args.regions,
        platform=args.platform,
        duration=args.duration,
        rampup=args.rampup,
        jmx_path=jmx_path,
        vusers=args.vusers,
        max_vusers_per_vm=args.max_vusers_per_vm,
        global_timeout=args.global_timeout,
        concurrency=args.concurrency,
        splitcsv=args.splitcsv,
        job_label=args.job_label,
        report_args=report_args,
        report_dir=args.report_dir,
    )
    if not job_id:
        ui_error("Failed to trigger job. Exiting.")
        sys.exit(1)

    # Monitor job status
    if not api.check_job_status(job_id, poll_interval=args.job_poll_interval):
        ui_error("Job did not complete successfully. Exiting.")
        sys.exit(1)

    # Monitor artifact status
    if not api.check_artifact_status(job_id, poll_interval=args.artifact_poll_interval):
        ui_error("Artifacts not ready. Exiting.")
        sys.exit(1)

    # Download artifacts (optional). Two artifacts are produced: 'JMeter'
    # (logs/results) and 'report' (HTML). Each is saved to its own zip.
    if args.no_download:
        ui_step("Skipping artifact download (--no-download)")
    else:
        prefix = args.output or job_id
        if prefix.endswith('.zip'):
            prefix = prefix[:-4]
        failed = []
        for name in ("JMeter", "report"):
            if not api.download_artifact(job_id, artifact_name=name,
                                         output_filename=f"{prefix}_{name}.zip"):
                failed.append(name)
        if failed:
            ui_error(f"Failed to download artifact(s): {', '.join(failed)}")
            sys.exit(1)

    ui_header("Done")
    ui_field("Job ID", job_id)
    ui_field("Project ID", api.project_id)
    ui_field("Dashboard", f"https://hyperexecute.lambdatest.com/hyperexecute/jobs/{job_id}")
    print("=" * _WIDTH)


def cmd_create(args) -> None:
    """
    Create the project and upload ALL files, then print the generated project
    ID. This command does NOT run a test - use 'trigger' with the printed
    project ID (and your run parameters) to execute.
    """
    username, api_key = _resolve_credentials(args)

    # The jmx name to use later at trigger time (just the uploaded filename).
    jmx_files = [f for f in args.files if f.lower().endswith('.jmx')]
    jmx_name = os.path.basename(jmx_files[0]) if jmx_files else '<your.jmx>'

    ui_header("HyperExecute  ·  Create Project + Upload Files")
    ui_field("User", username)
    ui_field("Project", f"{args.project_name}  ({args.project_type})")
    ui_field("Files", ", ".join(os.path.basename(f) for f in args.files))
    print("-" * _WIDTH)

    api = HyperExecuteAPI(username, api_key, debug=args.debug)

    # Step 1: Create the project
    pid = api.create_project(args.project_name, project_type=args.project_type)
    if not pid:
        # create_project() already printed a clear, friendly reason above.
        sys.exit(1)

    # Step 2: Upload all files at once
    if not api.upload_files(args.files):
        ui_error("Failed to upload files. Exiting.")
        sys.exit(1)

    # Make the generated project ID unmistakable and copy-paste friendly.
    # Lines are '#'-commented so the whole block reads like a script snippet.
    hashes = "#" * _WIDTH
    print("\n" + hashes)
    print("#  PROJECT CREATED  -  copy your Project ID below")
    print("#  Pass it to 'trigger' via --project-id")
    print("#  (or: export HYPEREXECUTE_PROJECT_ID=<the id below>)")
    print("#" + "-" * (_WIDTH - 1))
    print(f"{pid}")
    print("#" + "-" * (_WIDTH - 1))
    print("#  Ready-to-run example (edit run params freely):")
    print("#")
    print("#  python3 hyperexecute_automation.py trigger \\")
    print(f"#    --userName {username} --accessKey <ACCESS_KEY> \\")
    print(f"#    --project-id {pid} \\")
    print(f"#    --jmx-path {jmx_name} \\")
    print("#    --regions eastus --duration 60 --rampup 60 \\")
    print("#    --max-vusers-per-vm 5 --global-timeout 90 \\")
    print("#    --job-label \"AutomatedJmeterSample\"")
    print(hashes)


def cmd_trigger(args) -> None:
    """
    Existing user: project already created and files already uploaded.
    Just trigger + monitor + download against the given --project-id.
    """
    username, api_key = _resolve_credentials(args)

    # project-id and jmx-path are provided at runtime - via flag or env var.
    project_id = args.project_id or os.environ.get('HYPEREXECUTE_PROJECT_ID')
    if not project_id:
        ui_error("Project ID required at runtime: pass --project-id "
                 "or set HYPEREXECUTE_PROJECT_ID")
        sys.exit(1)

    jmx_path = args.jmx_path or os.environ.get('HYPEREXECUTE_JMX_PATH')
    if not jmx_path:
        ui_error("JMX path required at runtime: pass --jmx-path (e.g. loadtesting.jmx) "
                 "or set HYPEREXECUTE_JMX_PATH")
        sys.exit(1)

    # Values not provided at runtime fall back to the .jmx / platform defaults.
    jmx = "(from .jmx)"
    duration = f"{args.duration}s" if args.duration is not None else jmx
    rampup = f"{args.rampup}s" if args.rampup is not None else jmx
    vusers = args.max_vusers_per_vm if args.max_vusers_per_vm is not None else "(default)"
    timeout = f"{args.global_timeout} min" if args.global_timeout is not None else "(default)"

    ui_header("HyperExecute  ·  Trigger Test Run")
    ui_field("User", username)
    ui_field("Project ID", project_id)
    ui_field("JMX", jmx_path)
    ui_field("Regions", ", ".join(args.regions))
    users = args.vusers if args.vusers is not None else "(from jmx)"
    ui_field("Load", f"duration {duration} / rampup {rampup} / "
                     f"{users} users / {vusers} vusers-per-vm")
    ui_field("Timeout", timeout)
    ui_field("Job Label", args.job_label or "(none)")
    print("-" * _WIDTH)

    api = HyperExecuteAPI(username, api_key, project_id, debug=args.debug)
    _run_test(api, args, jmx_path)


def main():
    """Entry point: two subcommands - 'create' (new user) and 'trigger' (existing)."""
    parser = argparse.ArgumentParser(
        description='Automate the HyperExecute JMeter flow via two commands: '
                    "'create' (create project + upload files, prints project ID) "
                    "and 'trigger' (run a test on an existing project - holds all "
                    "the run parameters you tune between runs).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:

  # STEP 1 (once) - create the project and upload all files. Prints the project ID:
  python3 hyperexecute_automation.py create \\
      --userName myuser --accessKey mykey123 \\
      --project-name "AutomatedSample" \\
      --files wipro.jmx jmeter-parallel-0.12.jar system.properties user.properties

  # STEP 2 (repeatable) - run a test on that project, tuning the run parameters:
  python3 hyperexecute_automation.py trigger \\
      --userName myuser --accessKey mykey123 \\
      --project-id 01KY23M7T3YZAC3W0R433ZSSQV \\
      --jmx-path wipro.jmx \\
      --regions westus eastus centralindia southeastasia --platform azure \\
      --duration 60 --rampup 60 --max-vusers-per-vm 5 --global-timeout 90 \\
      --job-label "AutomatedJmeterSample"

  # Credentials can also come from env vars:
  export LAMBDATEST_USERNAME=myuser
  export LAMBDATEST_ACCESS_KEY=mykey123
"""
    )

    sub = parser.add_subparsers(dest='command', required=True,
                                metavar='{create,trigger}')

    # create: create project + upload files (no run). Takes the FILES only.
    create_p = sub.add_parser(
        'create',
        help='Create project + upload all files, print project ID (no test run).',
        formatter_class=argparse.RawDescriptionHelpFormatter)
    create_p.add_argument('--project-name', type=str, required=True,
                          help='Name for the NEW project to create')
    create_p.add_argument('--project-type', type=str, default='jmeter',
                          help='Project type (default: jmeter)')
    create_p.add_argument('--files', type=str, nargs='+', required=True,
                          help='All file(s) to upload at once: the .jmx plus any '
                               '.jar / .properties / .csv files')
    _add_credentials_args(create_p)
    create_p.set_defaults(func=cmd_create)

    # trigger: run a test on an existing project. Takes ALL run parameters.
    trigger_p = sub.add_parser(
        'trigger',
        help='Run a test on an existing project (no re-upload). Holds all run params.',
        formatter_class=argparse.RawDescriptionHelpFormatter)
    trigger_p.add_argument('--project-id', type=str, default=None,
                           help='Existing HyperExecute Project ID, provided at '
                                'runtime (or HYPEREXECUTE_PROJECT_ID env var)')
    trigger_p.add_argument('--jmx-path', type=str, default=None,
                           help='JMX name in the payload, e.g. wipro.jmx, provided '
                                'at runtime (or HYPEREXECUTE_JMX_PATH env var)')
    _add_credentials_args(trigger_p)
    _add_run_args(trigger_p)
    trigger_p.set_defaults(func=cmd_trigger)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
