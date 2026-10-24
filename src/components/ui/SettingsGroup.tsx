import React from "react";

interface SettingsGroupProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  description,
  children,
}) => {
  return (
    <div className="space-y-2">
      {title && (
        <div className="px-4">
          <h2 className="text-[13px] font-semibold text-text">
            {title}
          </h2>
          {description && (
            <p className="text-xs text-mid-gray mt-1">{description}</p>
          )}
        </div>
      )}
      <div className="border-y border-[rgba(16,32,31,0.13)] overflow-visible">
        <div className="divide-y divide-[rgba(16,32,31,0.13)]">{children}</div>
      </div>
    </div>
  );
};
