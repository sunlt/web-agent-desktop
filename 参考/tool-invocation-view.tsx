"use client";

import { useState } from "react";

interface ToolInvocationViewProps {
  tool: any; // Using any to handle AI SDK 6.x structure changes flexibly
}

export function ToolInvocationView({ tool }: ToolInvocationViewProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Determine tool name from various possible properties
  const rawToolName = tool.toolName || "Unknown Tool";
  const displayName = rawToolName
    .split("-")
    .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");

  // Standardize call vs result state
  // New SDK states: 'input-streaming', 'input-available', 'output-available', etc.
  // Old SDK states: 'call', 'result'

  const isCallState =
    tool.state === "call" ||
    tool.state === "input-streaming" ||
    tool.state === "input-available" ||
    tool.state === "approval-requested" ||
    tool.state === "approval-responded";

  const isResultState =
    tool.state === "result" ||
    tool.state === "output-available" ||
    tool.state === "output-error" ||
    tool.state === "output-denied";

  // Map input/args
  const args = tool.args || tool.input || {};

  // Map result/output
  const result = tool.result || tool.output;

  return (
    <div className="my-2 rounded-lg border border-white/10 bg-white/5 overflow-hidden font-sans w-full">
      {/* Header - Always visible */}
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          {/* Status Indicator */}
          <div className="relative flex items-center justify-center w-5 h-5">
            {isCallState ? (
              <div className="w-2.5 h-2.5 rounded-full bg-amber-400/80 animate-pulse shadow-[0_0_8px_rgba(251,191,36,0.5)]" />
            ) : (
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400/80 shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
            )}
          </div>

          <span className="text-sm font-medium text-gray-200">
            {displayName}
          </span>
        </div>

        {/* Chevron Icon */}
        <div
          className={`transform transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
        >
          <svg
            className="w-4 h-4 text-gray-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </div>

      {/* Content - Collapsible */}
      {isExpanded && (
        <div className="border-t border-white/10 bg-black/20 p-3 text-xs font-mono">
          {/* Arguments */}
          <div className="mb-2">
            <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">
              Input
            </div>
            <pre className="overflow-x-auto text-gray-300 bg-black/30 p-2 rounded border border-white/5">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>

          {/* Result (if available) */}
          {isResultState && (
            <div>
              <div className="text-gray-500 mb-1 uppercase tracking-wider text-[10px]">
                Result
              </div>
              <pre className="overflow-x-auto text-emerald-300/90 bg-black/30 p-2 rounded border border-white/5 max-h-60 scrollbar-thin">
                {typeof result === "string"
                  ? result
                  : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Minimized State Summary (when collapsed) */}
      {!isExpanded && isResultState && (
        <div className="px-3 pb-2 text-xs text-gray-500 truncate font-mono pl-10">
          Result:{" "}
          {typeof result === "string"
            ? result.slice(0, 50) + (result.length > 50 ? "..." : "")
            : "..."}
        </div>
      )}
      {!isExpanded && isCallState && (
        <div className="px-3 pb-2 text-xs text-gray-500 truncate font-mono pl-10">
          Running...
        </div>
      )}
    </div>
  );
}
