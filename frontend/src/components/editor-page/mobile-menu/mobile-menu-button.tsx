/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { IconButton } from '../../common/icon-button/icon-button'
import React, { useState } from 'react'
import { List as IconMenu } from 'react-bootstrap-icons'
import { MobileMenu } from './mobile-menu'

/**
 * Opens the nodeBook-style mobile editor menu.
 */
export const MobileMenuButton: React.FC = () => {
  const [show, setShow] = useState(false)

  return (
    <>
      <IconButton
        icon={IconMenu}
        size='sm'
        variant='outline-secondary'
        title='Menu'
        aria-label='Menu'
        onClick={() => setShow(true)}
      />
      <MobileMenu show={show} onHide={() => setShow(false)} />
    </>
  )
}
