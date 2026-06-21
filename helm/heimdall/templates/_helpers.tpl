{{/*
Expand the name of the chart.
*/}}
{{- define "heimdall.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
Includes the release name so multiple installs in the same cluster don't collide.
*/}}
{{- define "heimdall.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "heimdall.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{ include "heimdall.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "heimdall.selectorLabels" -}}
app.kubernetes.io/name: {{ include "heimdall.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "heimdall.serviceAccountName" -}}
{{- if .Values.serviceAccount.name }}
{{- .Values.serviceAccount.name }}
{{- else }}
{{- include "heimdall.fullname" . }}
{{- end }}
{{- end }}

{{/*
Slack webhook secret name (auto-created or existing).
*/}}
{{- define "heimdall.slackSecretName" -}}
{{- if .Values.slack.existingSecret.name }}
{{- .Values.slack.existingSecret.name }}
{{- else }}
{{- include "heimdall.fullname" . }}-slack
{{- end }}
{{- end }}

{{/*
API key secret name
*/}}
{{- define "heimdall.secretName" -}}
{{- if .Values.existingSecret.name }}
{{- .Values.existingSecret.name }}
{{- else }}
{{- include "heimdall.fullname" . }}-api-key
{{- end }}
{{- end }}
