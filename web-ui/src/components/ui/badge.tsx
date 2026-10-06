import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[#5b7cfa] focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[#5b7cfa] text-white",
        secondary: "border-transparent bg-[#26262d] text-[#9a9aa4]",
        destructive: "border-transparent bg-[#f56c6c] text-white",
        outline: "border-[#3a3a45] text-[#e8e8ec]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
