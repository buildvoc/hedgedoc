'use client'

import React from 'react'
import { Button } from 'react-bootstrap'

interface Props {
  active: boolean
  onChange: (active: boolean) => void
}

export const FilterByMemexOrphans: React.FC<Props> = ({ active, onChange }) => (
  <Button size='sm' variant={active ? 'warning' : 'outline-warning'} onClick={() => onChange(!active)}>
    Orphans
  </Button>
)
